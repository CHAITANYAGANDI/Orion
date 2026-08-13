"""Quotation verification.

The negative cases carry this file. A quotation is the one part of a brief that
claims to be exact, so a paraphrase reaching the reader as a quote is the
failure worth engineering against — it looks like evidence, and it gets
forwarded.
"""

from __future__ import annotations

from app.quotes import normalise, verify_quotes


class FakeSegment:
    def __init__(self, text: str, speaker: str = "Speaker 1", start: float = 0.0):
        self.text = text
        self.speaker = speaker
        self.start = start


SEGMENTS = [
    FakeSegment("We should ship the migration before the GitLab 14 launch.", "Speaker 1", 12.5),
    FakeSegment("Honestly, the current scanner is the thing slowing everyone down.", "Speaker 2", 48.0),
    FakeSegment("Yes.", "Speaker 3", 61.0),
    FakeSegment("I can have the benchmark numbers by Thursday afternoon.", "Speaker 2", 95.25),
]


def test_a_real_quote_is_kept_with_its_speaker_and_time():
    out = verify_quotes(["We should ship the migration before the GitLab 14 launch."], SEGMENTS)
    assert len(out) == 1
    assert out[0]["speaker"] == "Speaker 1"
    assert out[0]["start"] == 12.5


def test_a_paraphrase_is_dropped():
    # Every word plausible, nobody said it. This is the whole point.
    out = verify_quotes(["We ought to ship the migration ahead of the GitLab 14 release."], SEGMENTS)
    assert out == []


def test_an_invented_quote_is_dropped():
    out = verify_quotes(["The budget was approved by the board last quarter."], SEGMENTS)
    assert out == []


def test_punctuation_differences_do_not_break_a_real_quote():
    # Models routinely swap quote characters and drop a full stop. The words are
    # unchanged, so this must still match.
    out = verify_quotes(["“We should ship the migration before the GitLab 14 launch”"], SEGMENTS)
    assert len(out) == 1
    assert out[0]["start"] == 12.5


def test_a_trailing_attribution_is_stripped_not_rejected():
    out = verify_quotes(
        ["I can have the benchmark numbers by Thursday afternoon. - Speaker 2"], SEGMENTS
    )
    assert len(out) == 1
    assert out[0]["speaker"] == "Speaker 2"


def test_a_partial_quote_within_a_line_matches_and_is_clipped():
    out = verify_quotes(["the current scanner is the thing slowing everyone down"], SEGMENTS)
    assert len(out) == 1
    assert out[0]["speaker"] == "Speaker 2"
    # The wording returned is the transcript's, not the model's.
    assert "slowing everyone down" in out[0]["text"]


def test_very_short_lines_are_refused():
    # "Yes." appears verbatim, and is evidence of nothing. Allowing it would let
    # a filler word be quoted as though it carried meaning.
    assert verify_quotes(["Yes."], SEGMENTS) == []
    assert verify_quotes(["Yes"], SEGMENTS) == []


def test_the_same_line_is_not_quoted_twice():
    text = "We should ship the migration before the GitLab 14 launch."
    assert len(verify_quotes([text, text], SEGMENTS)) == 1


def test_results_are_ordered_by_when_they_were_said():
    out = verify_quotes(
        [
            "I can have the benchmark numbers by Thursday afternoon.",
            "We should ship the migration before the GitLab 14 launch.",
        ],
        SEGMENTS,
    )
    # Model ranking is not chronology; a reader scanning alongside the outline
    # expects the recording's order.
    assert [q["start"] for q in out] == [12.5, 95.25]


def test_empty_inputs_are_handled():
    assert verify_quotes([], SEGMENTS) == []
    assert verify_quotes(["anything at all here"], []) == []
    assert verify_quotes([""], SEGMENTS) == []


def test_normalise_ignores_case_punctuation_and_spacing():
    assert normalise("  We SHOULD ship,  the migration! ") == normalise("we should ship the migration")
