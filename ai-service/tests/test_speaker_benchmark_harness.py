"""The instrument, checked before anything is measured with it.

No human audio and no model here. What is under test is the harness's own
arithmetic — how it parses a filename, which trials it builds from a dataset,
how it classifies an outcome, how it computes a percentile — using synthetic
vectors whose answers are known in advance.

That distinction matters. A benchmark cannot be validated by its results,
because a benchmark whose ground truth is wrong does not fail: it reports a
false-accept rate, and the number looks exactly like a real one. So the ruler is
tested against known lengths, and the measuring is left to real recordings.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from app.voiceprints import EMBEDDING_DIM, Thresholds, cosine
from benchmarks.speaker_id import manifest, report, trials
from benchmarks.speaker_id.embed import Voiceprint, fingerprint


# --- the naming rule --------------------------------------------------------- #

def test_a_well_formed_name_is_read_field_by_field():
    clip = manifest.parse(Path("p01_enrol_laptop_quiet_d1_45s_02.wav"))

    assert clip.person == "p01"
    assert clip.role == "enrol"
    assert clip.device == "laptop"
    assert clip.environment == "quiet"
    assert clip.day == 1
    assert clip.target_seconds == 45
    assert clip.take == 2
    assert clip.condition == "laptop/quiet"


@pytest.mark.parametrize("name", [
    "p01_enrol_laptop_quiet_45s_02.wav",       # no session
    "p01_enrol_laptop_d1_45s_02.wav",          # no room
    "alice_enrol_laptop_quiet_d1_45s_02.wav",  # a name, not a pseudonym
    "p01_enrol_laptop_quiet_d1_45_02.wav",     # no unit on the duration
    "p01_enrol_laptop_quiet_d1_45s.wav",       # no take
])
def test_a_malformed_name_is_refused_rather_than_guessed(name):
    # Guessing is the failure that matters. A file quietly sorted into the wrong
    # person makes every distribution in the report wrong in a way that still
    # looks like a distribution.
    with pytest.raises(manifest.ManifestError):
        manifest.parse(Path(name))


def test_a_typo_in_a_closed_vocabulary_is_an_error_not_a_new_device():
    with pytest.raises(manifest.ManifestError) as raised:
        manifest.parse(Path("p01_enrol_phome_quiet_d1_45s_01.wav"))

    # Named, with the allowed values, because the person reading this is holding
    # a directory of files they have to rename.
    assert "phome" in str(raised.value)
    assert "laptop" in str(raised.value)


def test_a_stray_file_is_refused_by_extension():
    with pytest.raises(manifest.ManifestError):
        manifest.parse(Path("p01_enrol_laptop_quiet_d1_45s_01.txt"))


def test_a_missing_directory_says_what_to_do():
    with pytest.raises(manifest.ManifestError) as raised:
        manifest.load(Path("no/such/place"))

    assert "README" in str(raised.value)


# --- what the dataset cannot answer ------------------------------------------ #

def _clips(*names: str) -> list[manifest.Clip]:
    return [manifest.parse(Path(n)) for n in names]


def test_one_person_is_reported_as_no_false_accept_rate_at_all():
    have = manifest.coverage(_clips(
        "p01_enrol_laptop_quiet_d1_45s_01.wav",
        "p01_test_laptop_quiet_d1_20s_01.wav",
    ))

    gaps = " ".join(have.gaps())
    assert "false-accept" in gaps
    assert "second person" in gaps


def test_one_session_is_reported_because_it_is_the_easy_case():
    have = manifest.coverage(_clips(
        "p01_enrol_laptop_quiet_d1_45s_01.wav",
        "p02_enrol_laptop_quiet_d1_45s_01.wav",
        "p01_test_laptop_quiet_d1_20s_01.wav",
        "p02_test_laptop_quiet_d1_20s_01.wav",
    ))

    gaps = " ".join(have.gaps())
    # Two clips from one sitting share a room, a mic position and a voice that
    # has not slept since -- flattering, and not what the product faces.
    assert "one session" in gaps
    assert "same microphone" in gaps


def test_a_complete_dataset_reports_no_gaps():
    have = manifest.coverage(_clips(
        "p01_enrol_laptop_quiet_d1_45s_01.wav",
        "p02_enrol_laptop_quiet_d1_45s_01.wav",
        "p01_test_phone_noisy_d2_20s_01.wav",
        "p01_test_headset_quiet_d2_6s_01.wav",
        "p02_test_phone_quiet_d2_20s_01.wav",
    ))

    assert have.gaps() == []


# --- percentiles ------------------------------------------------------------- #

def test_percentiles_interpolate():
    values = [0.1, 0.2, 0.3, 0.4]

    assert report.percentile(values, 0.0) == pytest.approx(0.1)
    assert report.percentile(values, 0.5) == pytest.approx(0.25)
    assert report.percentile(values, 1.0) == pytest.approx(0.4)


def test_a_single_value_is_its_own_every_percentile():
    assert report.percentile([0.7], 0.25) == pytest.approx(0.7)


def test_an_empty_spread_prints_dashes_rather_than_zeros():
    # Zero would read as "these voices scored 0.000", which is a measurement.
    row = report.Spread.of([]).row("same person")

    assert "| - |" in row
    assert "0.000" not in row
    # ASCII, because a Windows console not in UTF-8 turns a nicer dash into a
    # replacement character in the middle of a table the reader is trusting.
    assert row.isascii()


# --- trials ------------------------------------------------------------------ #

def unit(seed: float) -> list[float]:
    """A normalised vector, well separated from the others.

    Sinusoidal rather than a linear ramp: two ramps differing by a constant
    point almost the same way, which would make two "different" people score
    0.999 and quietly turn a false-accept test into a true-accept one.
    """
    raw = [math.sin(seed * 1.7 + i * 0.37) for i in range(EMBEDDING_DIM)]
    norm = sum(v * v for v in raw) ** 0.5
    return [v / norm for v in raw]


def blend(a: list[float], b: list[float], weight: float) -> list[float]:
    """Somewhere between two voices, for building a near-miss on purpose."""
    mixed = [(1 - weight) * x + weight * y for x, y in zip(a, b)]
    norm = sum(v * v for v in mixed) ** 0.5
    return [v / norm for v in mixed]


class FakeEmbedder:
    """Returns a prepared vector per filename. No model, no audio, no ffmpeg."""

    def __init__(self, vectors: dict[str, list[float]], seconds: float = 20.0) -> None:
        self._vectors = vectors
        self._seconds = seconds

    def of(self, path: Path, *, limit_seconds: float | None = None) -> Voiceprint:
        seconds = self._seconds if limit_seconds is None else float(limit_seconds)
        return Voiceprint(
            vector=self._vectors[path.name],
            speech_seconds=seconds,
            clip_seconds=self._seconds,
        )


P1, P2 = unit(1.0), unit(9.0)

DATASET = {
    "p01_enrol_laptop_quiet_d1_45s_01.wav": P1,
    "p02_enrol_laptop_quiet_d1_45s_01.wav": P2,
    # p01 again, a little different, as a second recording of one person is.
    "p01_test_phone_quiet_d2_20s_01.wav": blend(P1, P2, 0.05),
    # p03 never enrolled: an impostor against both profiles.
    "p03_test_laptop_quiet_d2_20s_01.wav": unit(4.0),
}


def _run(dataset: dict[str, list[float]], **kwargs):
    clips = _clips(*dataset)
    embedder = FakeEmbedder(dataset)
    profiles = trials.build_profiles(clips, embedder)
    return profiles, trials.evaluate(clips, profiles, embedder, **kwargs)


def test_the_right_person_is_a_true_accept():
    _, (all_trials, _) = _run(DATASET)

    closed = next(t for t in all_trials
                  if t.clip.person == "p01" and t.mode == "closed")
    assert closed.decision == "MATCH:p01"
    assert closed.outcome == "true_accept"
    assert closed.correct


def test_the_same_clip_run_without_its_own_profile_must_refuse():
    # The false-accept measurement, and the reason every test clip is run twice.
    # With p01's own profile removed the only right answer is nobody.
    _, (all_trials, _) = _run(DATASET)

    opened = next(t for t in all_trials
                  if t.clip.person == "p01" and t.mode == "open")
    assert opened.expected == "NO_MATCH"
    assert opened.decision == "NO_MATCH"
    assert opened.outcome == "true_refusal"


def test_an_unenrolled_person_is_not_run_twice():
    # p03 has no profile, so the closed set is already the open set. Emitting
    # both would count the same impostor trial twice and halve the apparent
    # false-accept rate.
    _, (all_trials, _) = _run(DATASET)

    theirs = [t for t in all_trials if t.clip.person == "p03"]
    assert [t.mode for t in theirs] == ["closed"]
    assert theirs[0].expected == "NO_MATCH"


def test_a_wrong_match_is_counted_as_a_false_accept():
    # A voice that really is p02's, submitted as p03's clip: the profile set
    # holds a correct-looking answer that is the wrong person.
    dataset = dict(DATASET)
    dataset["p03_test_laptop_quiet_d2_20s_01.wav"] = blend(P2, P1, 0.02)

    _, (all_trials, _) = _run(dataset)

    impostor = next(t for t in all_trials if t.clip.person == "p03")
    assert impostor.decision == "MATCH:p02"
    assert impostor.outcome == "false_accept"
    assert not impostor.correct


def test_too_little_speech_is_refused_and_says_so():
    clips = _clips(*DATASET)
    embedder = FakeEmbedder(DATASET, seconds=Thresholds().min_seconds - 0.5)
    profiles = {"p02": trials.Enrolment("p02", P2, ["p02_enrol_laptop_quiet_d1_45s_01.wav"], 1)}

    all_trials, _ = trials.evaluate(clips, profiles, embedder)

    p01 = next(t for t in all_trials if t.clip.person == "p01")
    assert p01.decision == "NO_MATCH"
    assert p01.reason == "too_little_speech"


def test_comparisons_come_from_the_closed_run_only():
    # Otherwise every different-person pair is entered twice and the spread of
    # the distribution is reported from a dataset that does not exist.
    _, (_, comparisons) = _run(DATASET)

    for c in comparisons:
        assert c.trial.mode == "closed"

    p01_rows = [c for c in comparisons if c.trial.clip.person == "p01"]
    assert sorted(c.profile_person for c in p01_rows) == ["p01", "p02"]
    assert sum(1 for c in p01_rows if c.same_person) == 1


def test_a_profile_is_the_running_mean_learn_would_have_stored():
    # Two appearances, folded the way `learn` folds them: centroid([prev, new]),
    # each appearance counting once however long they spoke for.
    dataset = dict(DATASET)
    second = blend(P1, P2, 0.1)
    dataset["p01_enrol_headset_quiet_d2_45s_01.wav"] = second

    profiles, _ = _run(dataset)

    from app.voiceprints import centroid

    assert profiles["p01"].samples == 2
    assert len(profiles["p01"].sources) == 2
    expected = centroid([P1, second])
    assert cosine(profiles["p01"].vector, expected) == pytest.approx(1.0, abs=1e-9)


def test_an_enrolment_clip_too_short_to_learn_from_is_skipped():
    clips = _clips(*DATASET)
    embedder = FakeEmbedder(DATASET, seconds=Thresholds().min_seconds - 1)

    assert trials.build_profiles(clips, embedder) == {}


def test_the_truncation_sweep_reuses_the_same_take():
    _, (all_trials, _) = _run(DATASET, truncate=True)

    p01 = [t for t in all_trials
           if t.clip.person == "p01" and t.mode == "closed"]
    cuts = sorted(t.truncated_to for t in p01 if t.truncated_to is not None)
    # 20s clip, so 6 and 10 fit inside it and 20/45 do not add anything the
    # full-length row does not already cover.
    assert cuts == [6, 10]
    assert any(t.truncated_to is None for t in p01)


# --- the canary -------------------------------------------------------------- #

def test_the_harness_refuses_to_explain_a_decision_it_did_not_predict():
    """The check that keeps the `decision_reason` column honest.

    The reason is re-derived from the scores rather than reported by the
    matcher, so it can drift. Rather than let a stale explanation sit next to a
    correct decision, the harness raises.
    """
    trial = trials.Trial(
        trial_id="fake", mode="closed", clip=manifest.parse(
            Path("p01_test_laptop_quiet_d1_20s_01.wav")),
        truncated_to=None, speech_seconds=20.0, clip_seconds=20.0,
        candidate_fingerprint="x", profile_people=["p01"],
    )
    original = trials._reason
    try:
        trials._reason = lambda *_args, **_kw: "below_threshold"
        with pytest.raises(AssertionError, match="out of step"):
            trials.run_trial(trial, P1, [trials.Enrolment("p01", P1, ["e.wav"], 1)])
    finally:
        trials._reason = original


# --- nothing sensitive leaves ------------------------------------------------ #

def test_a_fingerprint_is_not_the_vector():
    one = fingerprint(P1)

    assert len(one) == 12
    assert one == fingerprint(P1)
    assert one != fingerprint(P2)
    # Not reversible, and not a rounded copy: no float from the vector appears.
    assert all(f"{v:.4f}" not in one for v in P1[:8])


def test_no_row_carries_an_embedding():
    from benchmarks.speaker_id.run import _comparison_rows, _trial_rows

    _, (all_trials, comparisons) = _run(DATASET)

    for row in _comparison_rows(comparisons) + _trial_rows(all_trials):
        rendered = " ".join(str(v) for v in row.values())
        # The one column named for the embedding holds a fingerprint, which is
        # 12 hex characters. A leaked vector would show up as a long run of
        # decimals or a bracketed list.
        assert "[" not in rendered
        assert len(row["candidate_embedding"]) == 12
