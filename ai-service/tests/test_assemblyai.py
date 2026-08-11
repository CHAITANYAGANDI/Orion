"""AssemblyAI response mapping.

Two of these guard failures that raise nothing and are therefore the ones that
reach production:

* **Milliseconds vs seconds.** AssemblyAI reports ms, `Segment` is seconds. A
  missed division puts every timestamp 1000x out — the player seeks past the
  end of the file, word highlighting never advances, and `_duration_of` reports
  a 40-minute meeting as 11 hours. Nothing throws.
* **Letter speaker labels.** AssemblyAI says "A"; every stored transcript, the
  rename feature and the per-speaker colours say "Speaker 1". Passing the
  letter through would not error, it would just make old and new meetings look
  like different products.
"""

from __future__ import annotations

import pytest

from app.providers.assemblyai_adapter import (
    parse_response,
    speaker_label,
)


def _payload(**overrides):
    base = {
        "status": "completed",
        "language_code": "en_us",
        "text": "Morning all. Morning.",
        "utterances": [
            {"speaker": "A", "text": "Morning all.", "start": 1500, "end": 3250},
            {"speaker": "B", "text": "Morning.", "start": 3500, "end": 4000},
        ],
    }
    base.update(overrides)
    return base


# --- the conversion that fails silently ------------------------------------ #
def test_milliseconds_become_seconds():
    segments = parse_response(_payload()).segments
    assert segments[0].start == 1.5
    assert segments[0].end == 3.25
    assert segments[1].start == 3.5


def test_a_long_meeting_stays_a_plausible_length():
    """The 1000x bug is only obvious at scale, so assert at scale."""
    payload = _payload(utterances=[
        {"speaker": "A", "text": "Closing remarks.", "start": 2_558_000, "end": 2_561_000},
    ])
    end = parse_response(payload).segments[-1].end
    # 42:41, not 711 hours.
    assert 2500 < end < 2600


def test_a_missing_timestamp_does_not_crash_the_meeting():
    payload = _payload(utterances=[
        {"speaker": "A", "text": "Hello.", "start": None, "end": "not-a-number"},
    ])
    segment = parse_response(payload).segments[0]
    assert segment.start == 0.0
    assert segment.end == 0.0


# --- speaker labels -------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("A", "Speaker 1"),
        ("B", "Speaker 2"),
        ("G", "Speaker 7"),
        ("a", "Speaker 1"),
        (" C ", "Speaker 3"),
    ],
)
def test_letters_map_to_the_labels_the_app_already_uses(raw, expected):
    assert speaker_label(raw) == expected


def test_a_real_name_is_kept_rather_than_numbered():
    """Speaker identification returns names; a name beats "Speaker 4"."""
    assert speaker_label("Cindy") == "Cindy"


@pytest.mark.parametrize("raw", [None, "", True, 3.7, []])
def test_an_unusable_speaker_falls_back_rather_than_inventing_one(raw):
    assert speaker_label(raw) == "Speaker 1"


def test_numeric_speakers_are_still_handled():
    """Defensive: the field is documented as a letter, but responses vary."""
    assert speaker_label(0) == "Speaker 1"
    assert speaker_label("1") == "Speaker 2"


# --- language -------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,expected",
    [("en_us", "en"), ("en", "en"), ("es_419", "es"), ("pt-br", "pt"), ("", "en"), (None, "en")],
)
def test_locale_is_reduced_to_a_bare_iso_code(raw, expected):
    """`en_us` reaching the UI fails every language lookup, silently."""
    assert parse_response(_payload(language_code=raw)).language == expected


# --- transcript assembly --------------------------------------------------- #
def test_transcript_is_rebuilt_with_speaker_prefixes():
    """The LLM reads this text; attribution has to survive into it."""
    assert parse_response(_payload()).transcript == (
        "Speaker 1: Morning all.\nSpeaker 2: Morning."
    )


def test_words_are_used_when_utterances_are_absent():
    payload = _payload(utterances=None, words=[
        {"text": "Morning", "start": 1000, "end": 1400, "speaker": "A"},
        {"text": "all.", "start": 1400, "end": 1800, "speaker": "A"},
        {"text": "Morning.", "start": 2000, "end": 2400, "speaker": "B"},
    ])
    segments = parse_response(payload).segments
    assert [s.speaker for s in segments] == ["Speaker 1", "Speaker 2"]
    assert segments[0].text == "Morning all."
    assert segments[0].start == 1.0
    assert segments[0].end == 1.8


# --- per-word timings ------------------------------------------------------ #
def test_word_timings_are_carried_through_and_converted():
    """These drive the highlight and click-to-seek; discarding them is why the
    highlight used to outrun the voice."""
    payload = _payload(utterances=[
        {
            "speaker": "A", "text": "Morning all.", "start": 1500, "end": 3250,
            "words": [
                {"text": "Morning", "start": 1500, "end": 2100},
                {"text": "all.", "start": 2400, "end": 3250},
            ],
        },
    ])
    words = parse_response(payload).segments[0].words
    assert [w.text for w in words] == ["Morning", "all."]
    assert words[0].start == 1.5
    assert words[0].end == 2.1
    # The gap between 2.1 and 2.4 is a real pause. An even-rate estimate would
    # have swallowed it and pushed the highlight ahead — this is the whole point.
    assert words[1].start == 2.4


def test_a_segment_without_words_is_still_valid():
    """Older transcripts and providers with no word timings must still render."""
    segment = parse_response(_payload()).segments[0]
    assert segment.words == []


def test_the_word_fallback_path_keeps_timings_too():
    payload = _payload(utterances=None, words=[
        {"text": "Morning", "start": 1000, "end": 1400, "speaker": "A"},
        {"text": "all.", "start": 1400, "end": 1800, "speaker": "A"},
    ])
    words = parse_response(payload).segments[0].words
    assert [(w.text, w.start) for w in words] == [("Morning", 1.0), ("all.", 1.4)]


def test_a_response_with_nothing_usable_degrades_to_the_flat_text():
    payload = {"status": "completed", "text": "Some words.", "utterances": None, "words": None}
    result = parse_response(payload)
    assert result.transcript == "Some words."
    assert result.segments == []


def test_empty_utterances_are_skipped_not_rendered_as_blank_turns():
    payload = _payload(utterances=[
        {"speaker": "A", "text": "   ", "start": 0, "end": 100},
        {"speaker": "B", "text": "Real content.", "start": 200, "end": 900},
    ])
    segments = parse_response(payload).segments
    assert len(segments) == 1
    assert segments[0].text == "Real content."
