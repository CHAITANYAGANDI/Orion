"""Per-utterance language detection.

The tests that matter here are the negative ones. A detector that labels
everything is worse than no detector: it moves lines into languages they are not
in, and the label feeds summarisation and translation downstream. So most of
this file is about the cases where the honest answer is None.
"""

from __future__ import annotations

import pytest

from app.language import annotate_segments, detect_language


class FakeSegment:
    """Minimal stand-in — annotate_segments only touches .text and .language."""

    def __init__(self, text: str):
        self.text = text
        self.language: str | None = None


# --------------------------------------------------------------------------- #
# Script: certain, because it is a property of the codepoints
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "text,expected",
    [
        ("ఈ ప్రాజెక్ట్ గురించి మాట్లాడుదాం", "te"),
        ("हम इस प्रोजेक्ट के बारे में बात करेंगे", "hi"),
        ("Мы обсудим этот проект сегодня", "ru"),
        ("سنتحدث عن هذا المشروع اليوم", "ar"),
        ("우리는 오늘 이 프로젝트에 대해 이야기합니다", "ko"),
        ("Θα μιλήσουμε για αυτό το έργο", "el"),
    ],
)
def test_non_latin_scripts_are_identified(text, expected):
    assert detect_language(text) == expected


def test_kana_makes_it_japanese_not_chinese():
    # Han alone is Chinese; the kana is the only thing distinguishing them, and
    # getting this backwards mislabels every Japanese meeting.
    assert detect_language("このプロジェクトについて話しましょう") == "ja"


def test_han_without_kana_is_chinese():
    assert detect_language("我们今天讨论这个项目") == "zh"


def test_a_borrowed_name_does_not_flip_the_language():
    # One Telugu word in an English sentence is a borrowing, not a switch.
    text = "We should ask ప్రియ about the migration timeline before Friday"
    assert detect_language(text) == "en"


# --------------------------------------------------------------------------- #
# Latin: stopwords, with thresholds
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "text,expected",
    [
        ("I think we should ship it on Friday if the tests are green", "en"),
        ("Creo que deberíamos enviarlo el viernes si las pruebas están bien", "es"),
        ("Je pense que nous devons le faire maintenant pour les clients", "fr"),
        ("Ich denke dass wir das jetzt machen sollten für die Kunden", "de"),
    ],
)
def test_latin_languages_from_function_words(text, expected):
    assert detect_language(text) == expected


def test_short_utterances_are_not_guessed():
    # "Okay." is not evidence. Every one of these is plausible in six languages.
    for text in ["Okay.", "Yeah", "Sure, right", "Mm-hmm", "No."]:
        assert detect_language(text) is None


def test_digits_and_punctuation_yield_nothing():
    assert detect_language("42 — 3.14, 100%") is None
    assert detect_language("") is None
    assert detect_language("   ") is None


def test_proper_nouns_alone_are_not_a_language():
    # No function words at all, so nothing to recognise.
    assert detect_language("Kubernetes Postgres Kafka Redis MinIO") is None


# --------------------------------------------------------------------------- #
# annotate_segments: only the exceptions get labelled
# --------------------------------------------------------------------------- #
def test_only_lines_differing_from_the_meeting_are_labelled():
    segments = [
        FakeSegment("I think we should ship it on Friday if the tests are green"),
        FakeSegment("ఈ ప్రాజెక్ట్ గురించి మాట్లాడుదాం"),
        FakeSegment("Okay."),
    ]
    annotate_segments(segments, "en")

    # Matches the meeting language — labelling it would tag every line in a
    # monolingual meeting and make the marker meaningless.
    assert segments[0].language is None
    assert segments[1].language == "te"
    # Unknown stays unknown rather than defaulting to the meeting language.
    assert segments[2].language is None


def test_the_minority_language_flips_with_the_meeting_language():
    segments = [
        FakeSegment("I think we should ship it on Friday if the tests are green"),
        FakeSegment("ఈ ప్రాజెక్ట్ గురించి మాట్లాడుదాం"),
    ]
    annotate_segments(segments, "te")

    # Same two lines, Telugu meeting: now the English one is the exception.
    assert segments[0].language == "en"
    assert segments[1].language is None


def test_locale_suffixes_are_reduced_before_comparing():
    # "en-US" must count as "en", or every English line in an en-US meeting
    # would be marked as a foreign language.
    segments = [FakeSegment("I think we should ship it on Friday if the tests are green")]
    annotate_segments(segments, "en-US")
    assert segments[0].language is None


def test_no_meeting_language_still_labels_what_it_can():
    segments = [FakeSegment("ఈ ప్రాజెక్ట్ గురించి మాట్లాడుదాం")]
    annotate_segments(segments, None)
    assert segments[0].language == "te"
