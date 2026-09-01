"""The two diarization bugs, pinned so they cannot come back.

Both were reported from real meetings:

1. A short interjection — "Exactly." — was absorbed into the turn around it,
   so one person appeared to have said something another person said.
2. The second person to speak displayed as **Speaker 4**, because the provider
   had clustered them as "D" and Reverie decoded the letter by its position in
   the alphabet.

The cases below are lettered to match the specification they were written from.
They exercise `parse_response` rather than the helpers wherever they can, since
the helpers were never the part that was wrong — the wiring was.

## What the provider actually does, measured

Written after putting spliced two-voice audio through the live API, with the
speaker boundaries known exactly because the file was assembled from separate
takes. AssemblyAI's async diarization got that recording completely right: five
utterances, the one-word "Exactly." on its own with its own label, both with and
without `speakers_expected`. So the batch bug was never the provider mislabelling
words — it was Reverie discarding the word-level labels on the way past, which
left no way to express a speaker change inside an utterance and no way to notice
one had happened.

That distinction decides who can fix what, so the tests keep it visible: a
mid-utterance switch is *constructed* here rather than taken from a recording,
because the provider does not often produce one. It is the shape Reverie has to
survive, not the shape it usually meets.
"""

from __future__ import annotations

import pytest

from app.diarization import (
    UNKNOWN_SPEAKER,
    CanonicalSpeakers,
    SpokenWord,
    join_words,
    split_by_speaker,
    trace_lines,
)
from app.providers.assemblyai_adapter import parse_response


def word(text, speaker, start, end=None):
    """One word as AssemblyAI returns it: milliseconds, and a speaker each."""
    return {
        "text": text,
        "start": start,
        "end": end if end is not None else start + 400,
        "speaker": speaker,
        "confidence": 0.9,
    }


def utterance(speaker, words, text=None):
    """One utterance, with its own label and the words underneath it."""
    return {
        "speaker": speaker,
        "text": text if text is not None else " ".join(w["text"] for w in words),
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "words": words,
        "confidence": 0.9,
    }


def payload(utterances=None, words=None):
    body = {"status": "completed", "language_code": "en", "text": ""}
    if utterances is not None:
        body["utterances"] = utterances
    if words is not None:
        body["words"] = words
    return body


def shown(result):
    """The transcript as (speaker, text) pairs — what a reader sees."""
    return [(s.speaker, s.text) for s in result.segments]


# --------------------------------------------------------------------------- #
# Test A — a one-word interjection
# --------------------------------------------------------------------------- #
def test_a_one_word_interjection_survives_as_its_own_turn():
    """A A A A B A A A must become three turns, not one.

    The reported bug exactly. The provider put the whole thing in one utterance
    and labelled that utterance A, but attributed the fifth word to B. Reverie
    read only the utterance's label, so "exactly" was published under A's name —
    a quotation beside somebody who did not say it.
    """
    words = [
        word("We", "A", 0), word("should", "A", 500),
        word("ship", "A", 1000), word("Friday.", "A", 1500),
        word("Exactly.", "B", 2000),
        word("And", "A", 2500), word("then", "A", 3000), word("deploy.", "A", 3500),
    ]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    assert shown(result) == [
        ("Speaker 1", "We should ship Friday."),
        ("Speaker 2", "Exactly."),
        ("Speaker 1", "And then deploy."),
    ]


def test_a_short_turn_is_never_merged_for_being_short():
    """No length rule anywhere. These are all real things people say.

    Guarding against the obvious wrong fix — "merge segments shorter than three
    words into the neighbouring speaker" — which would reproduce the reported
    bug precisely while looking like a tidy-up.
    """
    for reply in ("Yes.", "No.", "Right.", "Exactly.", "Why?", "Okay.", "Me too."):
        words = [
            word("So", "A", 0), word("that's", "A", 400), word("agreed.", "A", 800),
            word(reply, "B", 1200),
            word("Moving", "A", 1600), word("on.", "A", 2000),
        ]
        result = parse_response(payload(utterances=[utterance("A", words)]))
        assert shown(result)[1] == ("Speaker 2", reply), reply


# --------------------------------------------------------------------------- #
# Test B — a two-word interjection, behind a non-contiguous label
# --------------------------------------------------------------------------- #
def test_a_two_word_interjection_from_a_late_letter_is_speaker_two():
    """Both bugs at once: the split has to happen *and* D has to be Speaker 2."""
    words = [
        word("We", "A", 0), word("should", "A", 400), word("ship", "A", 800),
        word("this", "A", 1200), word("Friday.", "A", 1600),
        word("Yes,", "D", 2000), word("exactly.", "D", 2400),
        word("and", "A", 2800), word("monitor", "A", 3200), word("production.", "A", 3600),
    ]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    assert shown(result) == [
        ("Speaker 1", "We should ship this Friday."),
        ("Speaker 2", "Yes, exactly."),
        # Capitalised because it begins a turn now, having previously been the
        # middle of a sentence.
        ("Speaker 1", "And monitor production."),
    ]


# --------------------------------------------------------------------------- #
# Test C / D / E — canonical numbering
# --------------------------------------------------------------------------- #
def test_non_contiguous_provider_labels_number_contiguously():
    """A, D, F -> Speaker 1, 2, 3. Never 1, 4, 6."""
    result = parse_response(payload(utterances=[
        utterance("A", [word("First.", "A", 0)]),
        utterance("A", [word("Still me.", "A", 1000)]),
        utterance("D", [word("Second voice.", "D", 2000)]),
        utterance("A", [word("Back again.", "A", 3000)]),
        utterance("F", [word("Third voice.", "F", 4000)]),
    ]))

    assert [s.speaker for s in result.segments] == [
        "Speaker 1", "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 3",
    ]


def test_the_first_voice_is_speaker_one_whatever_letter_it_got():
    """D first, then A. D is Speaker 1 because D spoke first."""
    result = parse_response(payload(utterances=[
        utterance("D", [word("I'll start.", "D", 0)]),
        utterance("D", [word("One more thing.", "D", 1000)]),
        utterance("A", [word("Go ahead.", "A", 2000)]),
    ]))

    assert [s.speaker for s in result.segments] == ["Speaker 1", "Speaker 1", "Speaker 2"]


def test_a_speaker_keeps_their_number_when_they_come_back():
    """A D A D -> 1 2 1 2. The mapping holds for the whole meeting."""
    result = parse_response(payload(utterances=[
        utterance("A", [word("Question.", "A", 0)]),
        utterance("D", [word("Answer.", "D", 1000)]),
        utterance("A", [word("Follow-up.", "A", 2000)]),
        utterance("D", [word("Answer again.", "D", 3000)]),
    ]))

    assert [s.speaker for s in result.segments] == [
        "Speaker 1", "Speaker 2", "Speaker 1", "Speaker 2",
    ]


def test_the_same_response_always_numbers_the_same_way():
    """Deterministic: no clock, no hash, no set iteration order in the mapping."""
    body = payload(utterances=[
        utterance("Q", [word("Hello.", "Q", 0)]),
        utterance("C", [word("Hi.", "C", 1000)]),
        utterance("Q", [word("Shall we start?", "Q", 2000)]),
    ])
    first = [(s.speaker, s.speaker_key, s.speaker_raw) for s in parse_response(body).segments]
    for _ in range(5):
        assert [(s.speaker, s.speaker_key, s.speaker_raw)
                for s in parse_response(body).segments] == first
    assert first[0] == ("Speaker 1", "spk_1", "Q")
    assert first[1] == ("Speaker 2", "spk_2", "C")


# --------------------------------------------------------------------------- #
# Test F — adjacent same speaker
# --------------------------------------------------------------------------- #
def test_words_from_one_speaker_stay_one_readable_turn():
    """A A A is one card, not three. Splitting only ever follows a real change."""
    words = [word("Just", "A", 0), word("one", "A", 400), word("person.", "A", 800)]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    assert shown(result) == [("Speaker 1", "Just one person.")]
    # And the provider's own formatting of the utterance is kept, not rebuilt.
    assert result.segments[0].words[0].text == "Just"


def test_an_utterance_whose_words_agree_keeps_the_providers_own_text():
    """Rebuilt text is subtly worse; only a split turn gets reassembled."""
    words = [word("three", "A", 0), word("open", "A", 400), word("questions", "A", 800)]
    result = parse_response(payload(utterances=[
        utterance("A", words, text="There are 3 open questions."),
    ]))

    assert result.segments[0].text == "There are 3 open questions."


# --------------------------------------------------------------------------- #
# Test G — unknown
# --------------------------------------------------------------------------- #
def test_an_unknown_speaker_is_not_quietly_promoted_to_speaker_one():
    """A, UNKNOWN, B — and the unknown turn stays unknown.

    It also must not consume a number: B is the second *attributed* voice and
    is Speaker 2, not Speaker 3.
    """
    result = parse_response(payload(utterances=[
        utterance("A", [word("Morning.", "A", 0)]),
        utterance("UNKNOWN", [word("mm hm", "UNKNOWN", 1000)]),
        utterance("B", [word("Morning.", "B", 2000)]),
    ]))

    assert [(s.speaker, s.speaker_status) for s in result.segments] == [
        ("Speaker 1", "attributed"),
        (UNKNOWN_SPEAKER, "unknown"),
        ("Speaker 2", "attributed"),
    ]
    # Persisted as unattributed rather than as a speaker with no key.
    assert result.segments[1].speaker_key is None


def test_pending_is_the_provider_declining_to_answer():
    """The live stream's placeholder. It used to display as a speaker named PENDING."""
    result = parse_response(payload(utterances=[
        utterance("PENDING", [word("Exactly.", "PENDING", 0)]),
    ]))

    assert result.segments[0].speaker == UNKNOWN_SPEAKER
    assert result.segments[0].speaker_status == "unknown"


# --------------------------------------------------------------------------- #
# Test H — punctuation
# --------------------------------------------------------------------------- #
def test_splitting_does_not_mangle_punctuation():
    """No orphaned comma, no space before a full stop, nothing dropped."""
    words = [
        word("We", "A", 0), word("should", "A", 400), word("ship", "A", 800),
        word("Friday,", "A", 1200),
        word("yes,", "B", 1600),
        word("if", "A", 2000), word("QA", "A", 2400), word("passes.", "A", 2800),
    ]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    assert shown(result) == [
        ("Speaker 1", "We should ship Friday,"),
        ("Speaker 2", "Yes,"),
        ("Speaker 1", "If QA passes."),
    ]
    for _, text in shown(result):
        assert " ," not in text and " ." not in text


def test_punctuation_arriving_as_its_own_token_is_not_left_stranded():
    """Some providers emit bare punctuation; a plain join would island it."""
    assert join_words([
        SpokenWord("Let's", 0, 0.4), SpokenWord("ship", 0.4, 0.8),
        SpokenWord("Friday", 0.8, 1.2), SpokenWord(",", 1.2, 1.2),
        SpokenWord("if", 1.2, 1.5), SpokenWord("QA", 1.5, 1.8),
    ]) == "Let's ship Friday, if QA"


def test_a_fragment_is_sentence_cased_without_corrupting_a_brand():
    assert join_words([SpokenWord("and", 0, 0.3)], capitalise=True) == "And"
    # "iPhone" must not become "IPhone".
    assert join_words([SpokenWord("iPhone", 0, 0.3)], capitalise=True) == "iPhone"
    assert join_words([SpokenWord("Already", 0, 0.3)], capitalise=True) == "Already"


# --------------------------------------------------------------------------- #
# Test J — the final transcript renumbers from scratch
# --------------------------------------------------------------------------- #
def test_the_final_transcript_numbers_from_its_own_chronology():
    """Live saw A then D; the final job clusters the same people as C then A.

    The final result has the whole recording to look at and is authoritative,
    so it renumbers from its own order of appearance. Carrying arbitrary live
    letters across would corrupt the authoritative answer to preserve a
    provisional one.
    """
    result = parse_response(payload(utterances=[
        utterance("C", [word("First thing.", "C", 0)]),
        utterance("A", [word("Second thing.", "A", 1000)]),
    ]))

    assert [(s.speaker, s.speaker_raw) for s in result.segments] == [
        ("Speaker 1", "C"),
        ("Speaker 2", "A"),
    ]


# --------------------------------------------------------------------------- #
# Word-level data has to reach the rest of the app
# --------------------------------------------------------------------------- #
def test_every_word_carries_both_identities():
    """The canonical label for the app, the raw token for diagnosing it."""
    words = [
        word("Ship", "A", 0), word("it.", "A", 400),
        word("Agreed.", "D", 800),
    ]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    first, second = result.segments
    assert [(w.text, w.speaker, w.speaker_raw) for w in first.words] == [
        ("Ship", "Speaker 1", "A"), ("it.", "Speaker 1", "A"),
    ]
    assert [(w.speaker, w.speaker_raw) for w in second.words] == [("Speaker 2", "D")]


def test_segment_spans_come_from_the_words_that_were_split_out():
    """Section 26: playback must land on the turn, so the times are real ones."""
    words = [
        word("Long", "A", 0, 500), word("preamble.", "A", 500, 1000),
        word("Exactly.", "B", 1200, 1800),
        word("Carrying", "A", 2000, 2600), word("on.", "A", 2600, 3000),
    ]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    assert [(s.start, s.end) for s in result.segments] == [
        (0.0, 1.0), (1.2, 1.8), (2.0, 3.0),
    ]


def test_timings_are_never_estimated_when_the_provider_gave_them():
    """No spreading a span evenly across text once a split has happened."""
    words = [word("One.", "A", 0, 300), word("Two.", "B", 5000, 5400)]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    assert result.segments[1].start == 5.0
    assert result.segments[1].words[0].start == 5.0


def test_a_word_the_provider_did_not_attribute_continues_the_current_run():
    """Gaps mid-utterance are common; honouring each one would shred a sentence."""
    words = [
        word("We", "A", 0), word("should", None, 400), word("ship.", "A", 800),
    ]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    assert shown(result) == [("Speaker 1", "We should ship.")]


def test_no_utterances_still_splits_on_word_level_speakers():
    """The fallback path, used when `speaker_labels` produced no utterances."""
    result = parse_response(payload(words=[
        word("We", "A", 0), word("should", "A", 400),
        word("Exactly.", "D", 800),
        word("ship.", "A", 1200),
    ]))

    assert shown(result) == [
        ("Speaker 1", "We should"),
        ("Speaker 2", "Exactly."),
        ("Speaker 1", "Ship."),
    ]


def test_an_utterance_without_word_detail_still_works():
    """Older responses, and providers that only attribute whole utterances."""
    result = parse_response(payload(utterances=[
        {"speaker": "D", "text": "No word list here.", "start": 0, "end": 2000},
    ]))

    assert shown(result) == [("Speaker 1", "No word list here.")]
    assert result.segments[0].words == []


# --------------------------------------------------------------------------- #
# The pieces, directly
# --------------------------------------------------------------------------- #
def test_split_by_speaker_draws_boundaries_only_where_the_provider_did():
    speakers = CanonicalSpeakers()
    runs = split_by_speaker([
        SpokenWord("a", 0, 1, speaker="A"),
        SpokenWord("b", 1, 2, speaker="A"),
        SpokenWord("c", 2, 3, speaker="B"),
        SpokenWord("d", 3, 4, speaker="A"),
    ], speakers)

    assert [(r.identity.label, [w.text for w in r.words]) for r in runs] == [
        ("Speaker 1", ["a", "b"]),
        ("Speaker 2", ["c"]),
        ("Speaker 1", ["d"]),
    ]
    # The middle run is a split fragment; the first is not.
    assert [r.split for r in runs] == [False, True, True]


def test_the_trace_shows_raw_beside_canonical():
    """Section 30. The view that settles whose bug a mislabel is.

    If the provider said B and this says Speaker 1, the fault is Reverie's. If
    the provider itself said A, no remapping here will fix it and the answer is
    expected-speaker constraints or better audio.
    """
    words = [word("we", "A", 10200, 10500), word("exactly", "D", 11020, 11400)]
    result = parse_response(payload(utterances=[utterance("A", words)]))

    lines = trace_lines(result.segments)
    assert lines[0] == '00:10.20  "we"  raw=A  canonical=Speaker 1'
    assert lines[1] == '00:11.02  "exactly"  raw=D  canonical=Speaker 2'


@pytest.mark.parametrize("empty", [[], None])
def test_the_trace_is_empty_rather_than_loud_when_there_is_nothing_to_say(empty):
    assert trace_lines(empty or []) == []


def test_the_trace_is_off_unless_someone_turned_it_on(caplog):
    """It prints words, so it is developer-only by construction.

    A per-word transcript dump in a deployment holding other people's meetings
    is a privacy incident wearing a diagnostic hat. INFO must stay clean.
    """
    words = [word("confidential", "A", 0), word("details", "A", 400)]
    with caplog.at_level("INFO", logger="ai-service.assemblyai"):
        parse_response(payload(utterances=[utterance("A", words)]))

    assert not any("confidential" in r.getMessage() for r in caplog.records)
    assert not any(r.levelname == "DEBUG" for r in caplog.records)


def test_the_trace_appears_once_debug_is_asked_for(caplog):
    words = [word("we", "A", 10200), word("exactly", "D", 11020)]
    with caplog.at_level("DEBUG", logger="ai-service.assemblyai"):
        parse_response(payload(utterances=[utterance("A", words)]))

    traced = [r.getMessage() for r in caplog.records if r.levelname == "DEBUG"]
    assert any("raw=D  canonical=Speaker 2" in line for line in traced)
