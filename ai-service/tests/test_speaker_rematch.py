"""The rules that decide whether an unresolved speaker gets a name.

Every test here is about a refusal. That is not an accident of what was easy to
test — it is the shape of the feature. Renaming *Speaker 2* to *Sarah* when it
was not Sarah puts a real person's name on words they never said, writes that
into the retrieval index, and gets it read back out of chat as a cited fact.
Leaving *Speaker 2* alone is the state the user was already in, and it is
visibly unfinished, which invites the manual fix that has always been there.

So the matcher is allowed to be wrong in exactly one direction, and these tests
pin that direction down.

Vectors are constructed directly rather than embedded from audio. The audio path
is the embedder's job and is exercised end to end elsewhere; what is under test
here is the decision, and the decision has to be readable without a gigabyte of
model to run it.
"""

from __future__ import annotations

import math

import pytest

from app.voiceprints import (
    EMBEDDING_DIM,
    Candidate,
    Match,
    Profile,
    Thresholds,
    centroid,
    cosine,
    is_unresolved,
    l2_normalise,
    match_speakers,
)


# --- building voices --------------------------------------------------------- #
def voice(seed: int, drift: float = 0.0) -> list[float]:
    """A deterministic unit vector; `drift` rotates it slightly away from itself.

    Standing in for "the same person recorded on a different day": near-identical
    with a small angle between the two. The rotation is applied in a single plane
    so the resulting cosine is predictable, which is what lets a test say
    "0.8-ish similar" and mean it.
    """
    base = [math.sin(seed * 1.7 + i * 0.37) for i in range(EMBEDDING_DIM)]
    unit = l2_normalise(base)
    if drift == 0.0:
        return unit
    other = l2_normalise([math.cos(seed * 2.3 + i * 0.11) for i in range(EMBEDDING_DIM)])
    # Gram-Schmidt: make `other` perpendicular, then rotate by `drift` radians.
    dot = sum(a * b for a, b in zip(unit, other))
    perp = l2_normalise([o - dot * u for u, o in zip(unit, other)])
    return l2_normalise([
        math.cos(drift) * u + math.sin(drift) * p for u, p in zip(unit, perp)
    ])


SARAH = voice(1)
TOM = voice(2)


def spoke(key: str, vector, seconds: float = 30.0) -> Candidate:
    return Candidate(speaker_key=key, embedding=vector, speech_seconds=seconds)


def known(name: str, vector, pid: str | None = None) -> Profile:
    return Profile(profile_id=pid or f"prof_{name.lower()}", display_name=name,
                   embedding=vector)


# --- 1. the case the feature exists for --------------------------------------- #
def test_a_confident_match_is_named():
    """Speaker 2, recorded on another day, is recognisably Sarah."""
    matches = match_speakers([spoke("spk_2", voice(1, drift=0.25))], [known("Sarah", SARAH)])

    assert [(m.speaker_key, m.display_name) for m in matches] == [("spk_2", "Sarah")]


def test_the_match_is_reported_per_speaker_not_per_turn():
    # "2 speakers rematched" is what the user did. How many turns moved is a
    # fact about the database.
    matches = match_speakers(
        [spoke("spk_1", voice(1, 0.2)), spoke("spk_2", voice(2, 0.2))],
        [known("Sarah", SARAH), known("Tom", TOM)],
    )
    assert len(matches) == 2
    assert {m.speaker_key for m in matches} == {"spk_1", "spk_2"}


# --- 2. weak evidence ---------------------------------------------------------- #
def test_a_weak_candidate_stays_unresolved():
    """Somebody who is a bit like Sarah is not Sarah."""
    assert match_speakers([spoke("spk_2", voice(3))], [known("Sarah", SARAH)]) == []


def test_the_threshold_is_a_floor_not_a_preference():
    # There is no "closest profile wins" fallback. With one profile and nothing
    # to compare it against, an under-threshold score still loses.
    lonely = [known("Sarah", SARAH)]
    assert match_speakers([spoke("spk_2", voice(1, drift=1.2))], lonely) == []


# --- 3. names a human typed ---------------------------------------------------- #
@pytest.mark.parametrize("label", ["Sarah", "Dr Patel", "Facilitator", "Interviewer 2",
                                   "The candidate", "Speaker of the House"])
def test_a_real_name_is_not_a_placeholder(label):
    """None of these may be overwritten by a rematch.

    The last two are the interesting ones. "Interviewer 2" ends in a digit and
    "Speaker of the House" starts with the word Speaker, and a cleverer test for
    "does this look like a name" gets both wrong. The rule is narrow on purpose:
    only labels Orion itself generates are up for grabs.
    """
    assert is_unresolved(label) is False


@pytest.mark.parametrize("label", ["Speaker 1", "Speaker 12", "speaker 3",
                                   "spk_2", "Unknown speaker"])
def test_a_generated_label_is_a_placeholder(label):
    assert is_unresolved(label) is True


def test_a_name_already_in_the_meeting_is_not_given_to_somebody_else():
    """Sarah is already named on another speaker's turns.

    Two people called Sarah in one transcript reads as a bug even in the case
    where it is arguably right, so the profile is skipped.
    """
    matches = match_speakers(
        [spoke("spk_3", voice(1, 0.2))],
        [known("Sarah", SARAH)],
        taken_names=frozenset({"sarah"}),
    )
    assert matches == []


# --- 4. nobody at all ---------------------------------------------------------- #
def test_an_unattributed_turn_is_not_unresolved():
    """A turn the provider declined to attribute has no voice of its own.

    Calling it unresolved would invite exactly the guess this refuses to make:
    the audio under it may be anybody's, or two people at once.
    """
    assert is_unresolved(None) is False
    assert is_unresolved("") is False
    assert is_unresolved("   ") is False


def test_too_little_speech_is_not_compared_at_all():
    """A voiceprint from two seconds of "Exactly." is noise with a shape.

    Not merely less accurate: a short sample drifts toward the middle of the
    embedding space, so it is plausibly close to *everybody* — the worst
    possible input to a nearest-neighbour rule.
    """
    identical = spoke("spk_2", SARAH, seconds=2.0)
    assert match_speakers([identical], [known("Sarah", SARAH)]) == []
    # And the same voice, with enough of it, does match — so the refusal above
    # is about the duration and nothing else.
    assert len(match_speakers([spoke("spk_2", SARAH, 30.0)], [known("Sarah", SARAH)])) == 1


def test_no_profiles_means_no_matches_rather_than_an_error():
    assert match_speakers([spoke("spk_1", SARAH)], []) == []


# --- 5. two people who sound alike --------------------------------------------- #
def test_two_close_candidates_force_nothing():
    """Both clear the threshold and neither wins.

    This, not the threshold, is what protects against siblings and colleagues
    with similar voices. "One of these two" is the honest answer and there is no
    way to say it in a transcript, so nothing is said.
    """
    twin_a = voice(1, drift=0.05)
    twin_b = voice(1, drift=0.10)
    matches = match_speakers(
        [spoke("spk_2", SARAH)],
        [known("Sarah", twin_a, "p1"), known("Sara", twin_b, "p2")],
    )
    assert matches == []


def test_the_margin_is_measured_against_every_profile_not_only_unclaimed_ones():
    """A profile another speaker will win still counts as the runner-up.

    The ambiguity is a property of the voice, not of who happened to be assigned
    first. Ignoring claimed profiles would let a coin-toss between two similar
    voices resolve itself in whichever order the loop ran.
    """
    near = voice(1, drift=0.08)
    matches = match_speakers(
        [spoke("spk_1", SARAH), spoke("spk_2", near)],
        [known("Sarah", SARAH, "p1"), known("Sarah's twin", near, "p2")],
    )
    assert matches == []


def test_one_profile_cannot_be_two_speakers_and_the_loser_gets_nothing():
    """The weaker claim is dropped, not downgraded to its second choice.

    Handing it the runner-up would be answering "who else could this be?", which
    is the guessing this module exists to prevent.
    """
    matches = match_speakers(
        [spoke("spk_1", voice(1, 0.10)), spoke("spk_2", voice(1, 0.30))],
        [known("Sarah", SARAH, "p1"), known("Tom", TOM, "p2")],
    )
    assert [m.speaker_key for m in matches] == ["spk_1"]
    assert matches[0].display_name == "Sarah"


# --- 7. what identity is NOT based on ------------------------------------------ #
def test_the_speaker_number_carries_no_weight():
    """spk_2 in this meeting has nothing to do with spk_2 in another.

    Numbers are assigned by who spoke first, so the only thing they share is the
    accident of who cleared their throat. Same key, opposite voices, opposite
    answers — which is only possible if the key is ignored entirely.
    """
    sarahs_profile = [known("Sarah", SARAH)]

    assert match_speakers([spoke("spk_2", voice(1, 0.2))], sarahs_profile) != []
    assert match_speakers([spoke("spk_2", TOM)], sarahs_profile) == []


def test_the_key_is_carried_through_but_never_compared():
    """It is an address for applying the result, not evidence for it."""
    matches = match_speakers([spoke("spk_7", voice(1, 0.2))], [known("Sarah", SARAH)])
    assert matches[0].speaker_key == "spk_7"


def test_the_matcher_is_given_no_words_and_no_model():
    """Structurally, not by assertion: there is nowhere to put a transcript.

    `Candidate` carries a key, a vector and a duration. There is no text field,
    no meeting id, no title, no date, and `app.voiceprints` imports nothing but
    the standard library — so no heuristic over what was said, and no LLM asked
    who was talking, can be introduced without changing the shape of this type.
    """
    import app.voiceprints as vp

    assert set(Candidate.__dataclass_fields__) == {
        "speaker_key", "embedding", "speech_seconds"
    }
    assert set(Profile.__dataclass_fields__) == {
        "profile_id", "display_name", "embedding", "sample_count"
    }
    # No provider, no client, no model, no transcript anywhere in the module.
    source = open(vp.__file__, encoding="utf-8").read()
    body = source.split('"""', 2)[2]  # past the module docstring
    for forbidden in ("openai", "llm", "httpx", "prompt", "completion"):
        assert forbidden not in body.lower(), forbidden


# --- the arithmetic underneath ------------------------------------------------- #
def test_cosine_is_one_for_a_vector_against_itself():
    assert cosine(SARAH, SARAH) == pytest.approx(1.0, abs=1e-9)


def test_mismatched_widths_compare_to_nothing_rather_than_raising():
    # Two embedders got mixed. A real bug, whose safe reading is "not
    # comparable" — and refusing to compare cannot rename anybody.
    assert cosine([1.0, 0.0], SARAH) == 0.0
    assert cosine([], SARAH) == 0.0


def test_a_profile_is_the_average_of_its_appearances_and_stays_unit_length():
    """Averaging is what makes a profile improve with use.

    Each sample was recorded in different conditions; the part they share is the
    speaker. Re-normalising afterwards matters because the mean of unit vectors
    is shorter than one, and an un-normalised profile would score lower against
    everything purely for being short.
    """
    merged = centroid([voice(1, 0.1), voice(1, -0.1)])

    assert math.sqrt(sum(v * v for v in merged)) == pytest.approx(1.0, abs=1e-9)
    assert cosine(merged, SARAH) > cosine(voice(1, 0.1), SARAH)


def test_averaging_across_different_widths_is_refused():
    with pytest.raises(ValueError):
        centroid([[1.0, 0.0], [1.0, 0.0, 0.0]])


# --- the thresholds are settings, and they bite -------------------------------- #
def test_loosening_the_threshold_changes_the_answer():
    """Proves the bar is doing work rather than being decoration."""
    weak = [spoke("spk_2", voice(1, drift=1.1))]
    sarah = [known("Sarah", SARAH)]

    assert match_speakers(weak, sarah) == []
    assert match_speakers(weak, sarah, thresholds=Thresholds(accept=0.4, margin=0.0)) != []


def test_the_similarity_travels_for_logs_but_is_not_a_probability():
    """It is returned, and the API layer deliberately does not render it.

    Cosine is the right quantity to threshold on and the wrong one to show: 0.71
    does not mean "71% likely to be Sarah", and the mapping depends on the model
    and on how much speech went into each side.
    """
    match = match_speakers([spoke("spk_2", SARAH)], [known("Sarah", SARAH)])[0]

    assert isinstance(match, Match)
    assert 0.0 <= match.similarity <= 1.0
    assert match.runner_up is None
