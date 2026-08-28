"""The scorer, checked against cases where the right answer is obvious.

A benchmark nobody has tested is a benchmark that will eventually report an
improvement that is not there — which is worse than having no benchmark, because
it is the same as having none plus confidence.
"""

from __future__ import annotations

import pytest

from benchmark.metrics import (
    Turn,
    cer,
    cpwer,
    edit_distance,
    normalise,
    score,
    speaker_counts,
    timestamp_drift,
    tokenise,
    wer,
)
from benchmark.reference import parse, parse_otter, parse_speaker_prefixed


# --- normalisation ---------------------------------------------------------- #
def test_case_and_punctuation_are_not_errors():
    assert normalise("Hello, World!") == normalise("hello world")


def test_accents_are_folded():
    assert normalise("café") == normalise("cafe")


def test_fillers_are_kept_because_dropping_them_is_a_real_difference():
    # Whether "um" belongs in a transcript is a product decision. The benchmark
    # measures the choice rather than hiding it.
    assert "um" in tokenise("So, um, we should ship.")


# --- WER -------------------------------------------------------------------- #
def test_a_perfect_transcript_scores_zero():
    assert wer("we should ship on friday", "We should ship on Friday.") == 0.0


def test_one_wrong_word_in_five_is_a_fifth():
    assert wer("we should ship on friday", "we should skip on friday") == pytest.approx(0.2)


def test_a_missing_word_counts_the_same_as_a_wrong_one():
    assert wer("we should ship on friday", "we should on friday") == pytest.approx(0.2)


def test_an_inserted_word_counts_too():
    assert wer("we should ship", "we should really ship") == pytest.approx(1 / 3)


def test_a_hallucinated_transcript_is_capped_rather_than_unbounded():
    # Uncapped this scores 10.0 and drags any average into nonsense.
    assert wer("hello", " ".join(["nonsense"] * 50)) == 1.0


def test_an_empty_hypothesis_is_a_total_loss():
    assert wer("we should ship on friday", "") == 1.0


def test_an_empty_reference_scores_nothing_rather_than_dividing_by_zero():
    assert wer("", "") == 0.0
    assert wer("", "invented") == 1.0


def test_edit_distance_handles_the_empty_cases():
    assert edit_distance(["a", "b"], ["a", "c"]) == 1
    assert edit_distance(["a"], []) == 1
    assert edit_distance([], ["a"]) == 1


# --- CER -------------------------------------------------------------------- #
def test_character_error_sees_what_word_error_rounds_off():
    # One letter wrong in a proper noun costs a whole word in WER and a
    # fortieth of one here, which is the difference keyterm prompting shows in.
    reference = "we deployed pgvector on friday"
    hypothesis = "we deployed pg vector on friday"
    assert cer(reference, hypothesis) < wer(reference, hypothesis)


# --- cpWER ------------------------------------------------------------------ #
def _reference():
    return [
        Turn("Speaker 1", "validated heaths quiet determination", 4.0),
        Turn("Speaker 2", "heath was such a compassionate soul", 20.0),
    ]


def test_speaker_labels_are_arbitrary_and_are_permuted():
    """The reference's "Speaker 1" and a provider's "A" have no reason to be
    the same person, so a transcript perfect apart from naming is perfect."""
    hypothesis = [
        Turn("A", "validated heaths quiet determination", 4.0),
        Turn("B", "heath was such a compassionate soul", 20.0),
    ]
    rate, mapping = cpwer(_reference(), hypothesis)
    assert rate == 0.0
    assert mapping == {"A": "Speaker 1", "B": "Speaker 2"}


def test_a_wholesale_label_swap_is_not_an_error():
    """Because it is not one. A and B are arbitrary names for two voices; if A
    is consistently the person the reference calls Speaker 2, the diarization
    is correct and only the naming differs -- which permutation absorbs."""
    swapped = [
        Turn("A", "heath was such a compassionate soul", 4.0),
        Turn("B", "validated heaths quiet determination", 20.0),
    ]
    rate, mapping = cpwer(_reference(), swapped)
    assert rate == 0.0
    assert mapping == {"A": "Speaker 2", "B": "Speaker 1"}


def test_words_attributed_to_the_wrong_person_are_penalised_where_wer_sees_nothing():
    """The number a meeting product lives on.

    Every word is present and in order, so plain WER scores this a flawless
    zero. One phrase has moved across a speaker boundary, which is precisely
    the failure users report as "the transcript is wrong" -- and cpWER is the
    only metric here that can see it.
    """
    reference = [
        Turn("Speaker 1", "alpha beta gamma", 0.0),
        Turn("Speaker 2", "delta epsilon zeta", 10.0),
    ]
    drifted = [
        Turn("A", "alpha beta gamma delta", 0.0),
        Turn("B", "epsilon zeta", 10.0),
    ]

    plain = wer(" ".join(t.text for t in reference),
                " ".join(t.text for t in drifted))
    attributed, _ = cpwer(reference, drifted)

    assert plain == 0.0
    assert attributed > 0.0


def test_hearing_one_speaker_where_there_were_two_costs_the_missing_one():
    merged = [Turn("A", "validated heaths quiet determination "
                        "heath was such a compassionate soul", 4.0)]
    rate, _ = cpwer(_reference(), merged)
    assert rate > 0.0


def test_inventing_a_speaker_is_penalised():
    split = [
        Turn("A", "validated heaths quiet", 4.0),
        Turn("B", "determination", 8.0),
        Turn("C", "heath was such a compassionate soul", 20.0),
    ]
    rate, _ = cpwer(_reference(), split)
    assert rate > 0.0


def test_nothing_to_compare_is_a_total_loss_not_a_perfect_score():
    assert cpwer(_reference(), [])[0] == 1.0
    assert cpwer([], [])[0] == 0.0


# --- speaker counting -------------------------------------------------------- #
def test_speaker_counts_ignore_empty_turns():
    reference = [Turn("Speaker 1", "hello"), Turn("Speaker 2", "   ")]
    assert speaker_counts(reference, [Turn("A", "hello")]) == (1, 1)


def test_the_scorecard_flags_a_wrong_speaker_count():
    card = score(_reference(), [Turn("A", "everything on one line", 4.0)])
    assert card.reference_speakers == 2
    assert card.hypothesis_speakers == 1
    assert card.speaker_count_correct is False


def test_the_scorecard_serialises_for_tracking_over_time():
    row = score(_reference(), _reference()).as_row()
    assert row["wer"] == 0.0
    assert row["cpwer"] == 0.0
    assert row["speaker_count_correct"] is True


# --- timestamps -------------------------------------------------------------- #
def test_timestamp_drift_catches_words_that_are_right_but_late():
    """The exact failure of the old browser preview: a line spoken at 0:04 and
    labelled 0:10 because that is when recognition happened to return."""
    late = [
        Turn("A", "validated heaths quiet determination", 10.0),
        Turn("B", "heath was such a compassionate soul", 26.0),
    ]
    assert timestamp_drift(_reference(), late) == pytest.approx(6.0)


def test_accurate_timestamps_drift_by_nothing():
    same = [Turn("A", t.text, t.start) for t in _reference()]
    assert timestamp_drift(_reference(), same) == 0.0


def test_unmeasurable_drift_is_none_and_not_zero():
    # "We could not measure this" and "this was perfect" are opposite findings
    # and must not average together.
    untimed = [Turn("A", "validated heaths quiet determination")]
    assert timestamp_drift(_reference(), untimed) is None


def test_drift_is_matched_on_content_not_on_position():
    # One extra turn near the start would otherwise compare off-by-one for the
    # rest of the meeting and report a misalignment as drift.
    with_extra = [
        Turn("A", "sorry one moment", 1.0),
        Turn("A", "validated heaths quiet determination", 4.0),
        Turn("B", "heath was such a compassionate soul", 20.0),
    ]
    assert timestamp_drift(_reference(), with_extra) == 0.0


# --- parsing ----------------------------------------------------------------- #
OTTER = """Speaker 1  0:04
Validated Heath's quiet determination to be truly accepted by you all here.

Speaker 2  0:20
Heath was such a compassionate and generous soul.

Transcribed by https://otter.ai
"""


def test_the_otter_export_shape_is_read_with_its_timestamps():
    turns = parse_otter(OTTER)
    assert [t.speaker for t in turns] == ["Speaker 1", "Speaker 2"]
    assert turns[0].start == 4.0
    assert turns[1].start == 20.0
    # The export stamps itself; that is not part of the meeting.
    assert "otter.ai" not in " ".join(t.text for t in turns)


def test_hours_are_handled():
    turns = parse_otter("Speaker 1  1:02:11  \nStill going.\n")
    assert turns[0].start == 3731.0


def test_orion_own_speaker_prefixed_output_is_read():
    turns = parse_speaker_prefixed("Speaker 1: Morning all.\nSpeaker 2: Morning.")
    assert [t.text for t in turns] == ["Morning all.", "Morning."]


def test_consecutive_lines_from_one_speaker_are_one_turn():
    # Whether a provider breaks a long turn in two is segmentation, not a
    # transcription error, and scoring it as one would penalise the tidier one.
    turns = parse_speaker_prefixed("Speaker 1: First part.\nSpeaker 1: Second part.")
    assert len(turns) == 1
    assert turns[0].text == "First part. Second part."


def test_the_format_is_sniffed_rather_than_configured():
    # A flag somebody sets wrong does not fail loudly: it produces one enormous
    # turn and a WER of 1.0 that reads as a catastrophic regression.
    assert len(parse(OTTER)) == 2
    assert len(parse("Speaker 1: Hello.\nSpeaker 2: Hi.")) == 2


def test_a_transcript_with_no_speakers_at_all_still_parses():
    turns = parse("Just some words with nobody attributed.")
    assert len(turns) == 1
    assert turns[0].text.startswith("Just some words")
