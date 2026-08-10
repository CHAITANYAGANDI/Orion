"""Recording facts and their rendering.

Length and turnout are the first things a reader wants and the only things the
transcript text cannot supply. Getting them wrong is worse than omitting them:
a brief that opens "length 0:00, 1 speaker" on a diarized hour-long meeting
reads as broken.
"""

from __future__ import annotations

from app.pipeline import _duration_of, _speaker_count_of
from app.providers.openai_adapter import _format_duration, _recording_facts
from app.schemas import Segment, TranscriptResponse


def _tr(*triples) -> TranscriptResponse:
    return TranscriptResponse(
        transcript="x",
        language="en",
        segments=[Segment(start=s, end=e, speaker=sp, text="t") for s, e, sp in triples],
    )


# --- duration ------------------------------------------------------------- #

def test_duration_is_the_latest_end_not_the_last_segment():
    """Overlapping speakers can leave the final segment ending early."""
    assert _duration_of(_tr((0, 30, "A"), (25, 90, "B"), (88, 89, "A"))) == 90


def test_duration_is_none_without_segments():
    assert _duration_of(TranscriptResponse(transcript="x", language="en", segments=[])) is None


# --- speaker count -------------------------------------------------------- #

def test_speaker_count_is_distinct_voices_not_turns():
    assert _speaker_count_of(_tr((0, 1, "A"), (1, 2, "B"), (2, 3, "A"), (3, 4, "B"))) == 2


def test_speaker_count_is_none_when_nothing_diarized():
    assert _speaker_count_of(TranscriptResponse(transcript="x", language="en", segments=[])) is None


# --- formatting ----------------------------------------------------------- #

def test_duration_formats_as_a_player_shows_it():
    assert _format_duration(2561) == "42:41"
    assert _format_duration(59) == "0:59"
    assert _format_duration(3600) == "1:00:00"
    assert _format_duration(3725) == "1:02:05"


def test_facts_line_states_both():
    text = _recording_facts(2561, 7)
    assert "length 42:41" in text
    assert "7 speakers" in text


def test_one_speaker_is_not_pluralized():
    assert "1 speaker." in _recording_facts(60, 1) or "1 speaker," in _recording_facts(60, 1)
    assert "1 speakers" not in _recording_facts(60, 1)


def test_missing_facts_produce_no_instruction_at_all():
    """Absent facts must not leave the model an empty claim to narrate."""
    assert _recording_facts(None, None) == ""
    assert _recording_facts(0, 0) == ""


def test_partial_facts_mention_only_what_is_known():
    only_length = _recording_facts(120, None)
    assert "2:00" in only_length
    assert "speaker" not in only_length

    only_speakers = _recording_facts(None, 3)
    assert "3 speakers" in only_speakers
    assert "length" not in only_speakers
