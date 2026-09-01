"""The §15 comparison: four systems, one word list, one set of human labels.

<h2>What is being compared</h2>

* **A. AssemblyAI raw** — the provider's own per-word labels.
* **B. Reverie parsing** — what ships today before any repair. Identical to A
  by construction, and that is the finding rather than a gap in the test: the
  parser is faithful, so where the provider is wrong Reverie is wrong.
* **C. SpeakerRefiner** — the ECAPA repair, modelled by its own stated rules.
* **D. Reconciliation** — the new path, given the diarizer's timeline.

<h2>How C is modelled</h2>

The old refiner needs real audio and real embeddings, so it cannot be run
against a synthetic fixture. What *can* be run is its published contract, which
is what decides its results on these cases: it examines only segments of at
least 6 seconds, needs at least 2 seconds of speech on each side of a candidate
boundary, and can only ever assign a speaker the provider already found.

That is a fair model because those three rules, not the embedding quality,
are what fail the hard fixtures. A one-word "Exactly." is out of reach at any
threshold. Where the rules do let it act, it is credited with succeeding — the
comparison is generous to the thing being replaced.
"""

from __future__ import annotations

import pytest

from app.diareval import score, table
from app.reconcile import assign
from tests.fixtures_diarization import ALL, Fixture

# The old refiner's own numbers, from app/rediarize.py's Limits.
REFINER_MIN_SEGMENT = 6.0
REFINER_MIN_SIDE = 2.0


def _provider_answers(fixture: Fixture) -> list[str | None]:
    """System A and B: the provider's labels, which Reverie passes through."""
    return list(fixture.provider)


def _refiner_answers(fixture: Fixture) -> list[str | None]:
    """System C, modelled by the three rules that decide its outcome.

    A provider label becomes a candidate only if the run of words carrying it
    spans at least 6 seconds. Inside such a run, a true boundary is repairable
    only if at least 2 seconds of speech sit on each side of it. Anything else
    keeps the provider's answer, which is what the refiner does when it declines.
    """
    answers: list[str | None] = list(fixture.provider)

    # Group consecutive words by provider label.
    runs: list[tuple[int, int]] = []
    start = 0
    for i in range(1, len(fixture.truth) + 1):
        if i == len(fixture.truth) or fixture.provider[i] != fixture.provider[start]:
            runs.append((start, i))
            start = i

    for lo, hi in runs:
        span = fixture.truth[hi - 1].end - fixture.truth[lo].start
        if span < REFINER_MIN_SEGMENT:
            continue  # too short to examine at all
        # Where does the truth actually change inside this run?
        for i in range(lo + 1, hi):
            if fixture.truth[i].speaker == fixture.truth[i - 1].speaker:
                continue
            left = fixture.truth[i - 1].end - fixture.truth[lo].start
            right = fixture.truth[hi - 1].end - fixture.truth[i].start
            if left < REFINER_MIN_SIDE or right < REFINER_MIN_SIDE:
                continue  # not enough audio either side to embed
            # It can act. Credit it with getting the split right, and with
            # assigning the far side to another *existing* provider speaker.
            other = next(
                (p for p in fixture.provider if p and p != fixture.provider[lo]),
                fixture.provider[lo],
            )
            for j in range(i, hi):
                answers[j] = other
            break
    return answers


def _reconciled_answers(fixture: Fixture) -> list[str | None]:
    """System D: every word placed by maximum overlap with the timeline."""
    result = assign(fixture.words, fixture.timeline)
    return [v.key for v in result.verdicts]


SYSTEMS = {
    "A. AAI raw": _provider_answers,
    "B. Reverie today": _provider_answers,
    "C. SpeakerRefiner": _refiner_answers,
    "D. Reconciliation": _reconciled_answers,
}


def _all_scores():
    rows = []
    for name, run in SYSTEMS.items():
        for fixture in ALL:
            rows.append(score(name, fixture.name, fixture.truth, run(fixture)))
    return rows


def test_the_new_path_beats_every_other_system_overall():
    rows = _all_scores()

    def attribution(system: str) -> float:
        mine = [r for r in rows if r.system == system]
        return sum(r.correct for r in mine) / sum(r.words for r in mine)

    new = attribution("D. Reconciliation")
    for other in ("A. AAI raw", "B. Reverie today", "C. SpeakerRefiner"):
        assert new > attribution(other), f"{other} scored {attribution(other):.3f} vs {new:.3f}"


def test_reverie_today_is_exactly_the_provider():
    """The parser is faithful, and that is the root cause rather than a bug in it.

    Asserted rather than assumed: it is the finding the whole rewrite rests on.
    If these two ever diverge, the diagnosis in docs/diarization.md is stale.
    """
    rows = {(r.system, r.fixture): r for r in _all_scores()}
    for fixture in ALL:
        a = rows[("A. AAI raw", fixture.name)]
        b = rows[("B. Reverie today", fixture.name)]
        assert a.correct == b.correct
        assert a.missed_boundaries == b.missed_boundaries


def test_the_monologue_is_never_split_by_any_system():
    """A false boundary is worse than a missed one: it invents a participant."""
    rows = _all_scores()
    for r in rows:
        if r.fixture == "monologue (must not split)":
            assert r.false_boundaries == 0, f"{r.system} split a monologue"


@pytest.mark.parametrize("fixture", [f for f in ALL if f.name in {
    "zero-pause handoff",
    "long merged turn",
}], ids=lambda f: f.name)
def test_what_the_old_refiner_could_already_do_still_works(fixture):
    """The two cases it was built for, and did handle — verified live on the
    real recording earlier. A rewrite that regressed these would be trading one
    failure for another, so both systems are held to the same bar."""
    old = score("old", fixture.name, fixture.truth, _refiner_answers(fixture))
    new = score("new", fixture.name, fixture.truth, _reconciled_answers(fixture))

    assert old.attribution == 1.0, "fixture no longer models what the refiner fixes"
    assert new.attribution == 1.0
    assert new.false_boundaries == 0


@pytest.mark.parametrize("fixture", [f for f in ALL if f.name in {
    "one-word interjection",
    "short handoff (4.85s)",
    "rapid alternation",
}], ids=lambda f: f.name)
def test_the_short_cases_the_old_refiner_could_never_reach(fixture):
    """§6: the 6-second floor was the biggest visible limitation.

    Each of these has both provider labels present, so the refiner has a
    reference to work from and is not being handicapped by the fixture. What
    stops it is length alone."""
    old = score("old", fixture.name, fixture.truth, _refiner_answers(fixture))
    new = score("new", fixture.name, fixture.truth, _reconciled_answers(fixture))

    assert old.missed_boundaries > 0, "fixture no longer exercises the old limit"
    assert new.missed_boundaries == 0
    assert new.attribution > old.attribution


def test_a_speaker_the_provider_missed_can_be_recovered():
    """§4: the old repair could never create a speaker. This one may."""
    fixture = next(f for f in ALL if f.name == "third speaker missed by provider")

    old = score("old", fixture.name, fixture.truth, _refiner_answers(fixture))
    new = score("new", fixture.name, fixture.truth, _reconciled_answers(fixture))

    assert old.hypothesis_speakers == 2  # stuck with the provider's two
    assert new.hypothesis_speakers == 3
    assert new.speaker_count_error == 0
    assert new.attribution == 1.0


def test_similar_voices_are_missed_rather_than_forced():
    """§14: no unsafe forced identity when the model cannot hear a difference."""
    fixture = next(f for f in ALL if f.name == "similar voices")
    new = score("new", fixture.name, fixture.truth, _reconciled_answers(fixture))

    # It merges them -- a miss. What it must not do is invent a third voice or
    # split them in the wrong place.
    assert new.missed_boundaries > 0
    assert new.false_boundaries == 0
    assert new.speaker_count_error == -1


def test_a_noisy_region_is_left_unresolved_rather_than_guessed():
    """§14: no confident invented assignment where the model heard nothing."""
    fixture = next(f for f in ALL if f.name == "noisy region")
    result = assign(fixture.words, fixture.timeline)

    unresolved = [v for v in result.verdicts if not v.resolved]
    assert unresolved, "expected the unintelligible word to go unattributed"
    assert all(v.reason for v in unresolved), "an unresolved word must say why"


def test_the_comparison_table_renders(capsys):
    """Printed so `pytest -s` produces the §15 table on demand."""
    print("\n" + table(_all_scores()))
    assert "D. Reconciliation" in capsys.readouterr().out
