"""Quotation verification.

The negative cases carry this file. A quotation is the one part of a brief that
claims to be exact, so a paraphrase reaching the reader as a quote is the
failure worth engineering against — it looks like evidence, and it gets
forwarded.
"""

from __future__ import annotations

from app.quotes import anchor_outline, normalise, verify_quotes


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


# --------------------------------------------------------------------------- #
# Anchoring outline headings
#
# Same discipline as the quotations above, for a different reason. A quotation
# that is wrong looks like evidence; an outline heading that is wrong looks like
# a working link, and sends the reader to a minute where the topic is not being
# discussed. Both failures are silent, so both are engineered against by
# refusing to accept anything the transcript does not contain.
# --------------------------------------------------------------------------- #
class FakeGroup:
    def __init__(self, heading: str, start_quote: str = ""):
        self.heading = heading
        self.bullets: list[str] = []
        self.start_quote = start_quote
        self.start_seconds = None


class FakeSection:
    def __init__(self, *groups: FakeGroup):
        self.groups = list(groups)


def test_a_heading_is_timed_from_the_segment_its_quote_was_found_in():
    group = FakeGroup("Shipping the migration", "We should ship the migration before the GitLab 14 launch.")
    anchor_outline([FakeSection(group)], SEGMENTS)

    # The segment's own timestamp, never a number the model produced — the
    # transcript it was given carries no times to produce one from.
    assert group.start_seconds == 12.5


def test_the_scaffolding_quote_does_not_leave_the_service():
    group = FakeGroup("Shipping the migration", "We should ship the migration before the GitLab 14 launch.")
    anchor_outline([FakeSection(group)], SEGMENTS)

    # It existed to find the timestamp. Passing it on would put an unverified
    # claim about the transcript into the API for nobody's benefit.
    assert group.start_quote == ""


def test_a_paraphrased_quote_anchors_nothing():
    group = FakeGroup("Shipping the migration", "The team agreed to ship the migration first.")
    anchor_outline([FakeSection(group)], SEGMENTS)

    # Nobody said this. A heading with no timestamp renders as plain text, which
    # is a better outcome than a link to a guess.
    assert group.start_seconds is None


def test_a_short_quote_anchors_nothing():
    group = FakeGroup("Agreement", "Yes.")
    anchor_outline([FakeSection(group)], SEGMENTS)

    # "Yes" is in every meeting and would anchor the heading to whichever
    # minute happened to contain it first.
    assert group.start_seconds is None


def test_punctuation_the_model_changed_still_anchors():
    group = FakeGroup(
        "Benchmarks",
        "I can have the benchmark numbers by Thursday afternoon",
    )
    anchor_outline([FakeSection(group)], SEGMENTS)

    assert group.start_seconds == 95.25


def test_a_heading_with_no_quote_is_left_alone():
    group = FakeGroup("Something the model did not mark")
    anchor_outline([FakeSection(group)], SEGMENTS)

    assert group.start_seconds is None
    assert group.start_quote == ""


def test_sections_without_groups_are_survivable():
    class Bare:
        groups = None

    anchor_outline([Bare()], SEGMENTS)
