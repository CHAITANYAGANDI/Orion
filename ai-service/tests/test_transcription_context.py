"""What Reverie tells the transcriber before it hears anything.

The failure this guards against is not a crash. It is a prompt that looks
configured and biases nothing — or worse, one built from a date-stamped default
title, which teaches the model that the meeting is about recordings and dates.

Two of the three sources this module had are gone. Custom vocabulary and known
speakers were removed from the product, so nothing supplies jargon or names any
more; what is left is the meeting's own title, project and type, plus an
``organisations`` list that nothing currently fills. The prompt tests below are
therefore about the prose channel, and the keyterm tests are mostly about it
staying honest when it has nothing to say.
"""

from __future__ import annotations

import pytest

from app.transcription_context import (
    KEYTERM_MAX_WORDS,
    KEYTERMS_MAX_UNIVERSAL_2,
    KEYTERMS_MAX_UNIVERSAL_3,
    PROMPT_MAX_WORDS,
    MeetingContext,
    TranscriptionContextBuilder,
    build_keyterms,
    build_prompt,
    meaningful_title,
)


# --- titles that are not titles --------------------------------------------- #
@pytest.mark.parametrize("title", [
    "Recording - 19/08/2026, 21:15",
    "recording-1755084000000.webm",
    "Untitled",
    "New meeting",
    "audio",
    "2026-08-19 14:00",
    "",
    None,
    "  ",
    "ab",
])
def test_a_name_nobody_chose_is_not_context(title):
    """The default Reverie gives an unnamed recording says nothing about it.

    An empty prompt is ignored by the model. A misleading one is obeyed.
    """
    assert meaningful_title(title) is None


@pytest.mark.parametrize("title", [
    "Tuesday design review",
    "Q4 planning with Acme",
    "1:1 with Sarah",
])
def test_a_real_title_survives(title):
    assert meaningful_title(title) == title


# --- the prompt -------------------------------------------------------------- #
def test_nothing_known_produces_no_prompt_at_all():
    # None, not "". A provider given `prompt: ""` has been told something
    # different from a provider not given a prompt.
    assert build_prompt(MeetingContext()) is None
    assert build_prompt(MeetingContext(title="Recording - 19/08/2026")) is None


def test_the_prompt_names_the_meeting_its_project_and_its_subject():
    prompt = build_prompt(
        MeetingContext(
            title="Sprint review",
            project="Reverie",
            meeting_type="Engineering sprint review",
            organisations=["AssemblyAI"],
        )
    )
    assert prompt is not None
    for expected in ("Engineering sprint review", "Reverie", "AssemblyAI"):
        assert expected in prompt


def test_the_prompt_no_longer_names_people_because_nothing_supplies_them():
    """Known speakers filled a participant list that reached this prompt.

    The feature is gone, and the point of the assertion is that the sentence
    went with it rather than being rendered from an empty list — "Participants
    include ." is a prompt that says the meeting had nobody in it.
    """
    prompt = build_prompt(
        MeetingContext(title="Sprint review", meeting_type="Standup")
    ) or ""
    assert "Participants" not in prompt


def test_the_prompt_is_a_description_and_never_an_instruction():
    """A transcription prompt that asks for formatting is asking the model to
    stop transcribing and start editing, and invented words are indistinguishable
    from spoken ones."""
    prompt = build_prompt(
        MeetingContext(title="Sprint review", meeting_type="Standup",
                       organisations=["Kafka"])
    ) or ""
    lowered = prompt.lower()
    for forbidden in ("summar", "format", "correct", "rewrite", "bullet",
                      "please", "you are", "output"):
        assert forbidden not in lowered


def test_the_prompt_is_capped_rather_than_allowed_to_become_the_meeting():
    prompt = build_prompt(
        MeetingContext(
            title="A very long title " * 20,
            meeting_type="Engineering sprint review",
            organisations=[f"Org{i}" for i in range(80)],
        )
    )
    assert prompt is not None
    assert len(prompt.split()) <= PROMPT_MAX_WORDS


def test_the_prompt_is_deterministic():
    """Same meeting in, same string out — twice, and from separate objects.

    A prompt built from set iteration would differ between runs for reasons
    nobody can see, and a benchmark cannot tell that apart from a regression.
    """
    def make():
        return MeetingContext(
            title="Sprint review", project="Reverie",
            organisations=["Acme", "acme", "Beta"],
        )

    assert build_prompt(make()) == build_prompt(make())


def test_a_type_alone_is_enough_to_be_worth_saying():
    assert build_prompt(MeetingContext(meeting_type="Customer discovery call")) is not None


# --- keyterms ---------------------------------------------------------------- #
def test_keyterms_are_empty_when_nothing_names_anything():
    """The ordinary case now, and the reason this is stated rather than assumed.

    Both real sources — the account's vocabulary and its known speakers — were
    removed. An adapter that received `[]` here and sent a boosting field
    anyway would be biasing a model toward nothing at all.
    """
    assert build_keyterms(MeetingContext(title="Sprint review", project="Reverie")) == []
    assert build_keyterms(MeetingContext()) == []


def test_keyterms_still_carry_what_the_remaining_source_holds():
    # `organisations` is the one input left. Nothing fills it today; the
    # machinery is kept because a provider channel that works is worth more
    # than one that has to be rebuilt.
    assert build_keyterms(MeetingContext(organisations=["Acme", "pgvector"])) == [
        "Acme", "pgvector",
    ]


def test_keyterms_are_deduplicated_case_insensitively_keeping_the_first_spelling():
    terms = build_keyterms(MeetingContext(organisations=["Sarah", "sarah", "SARAH", "Kafka"]))
    assert terms == ["Sarah", "Kafka"]


def test_blank_and_single_character_terms_are_dropped():
    assert build_keyterms(MeetingContext(organisations=["", "  ", "a", "ok"])) == ["ok"]


def test_a_phrase_too_long_for_the_provider_is_dropped_not_truncated():
    """Half a phrase is a different phrase, and biasing toward it is worse than
    not biasing at all."""
    long_phrase = " ".join(f"w{i}" for i in range(KEYTERM_MAX_WORDS + 1))
    ok_phrase = " ".join(f"v{i}" for i in range(KEYTERM_MAX_WORDS))
    terms = build_keyterms(MeetingContext(organisations=[long_phrase, ok_phrase]))
    assert terms == [ok_phrase]


def test_the_list_is_capped_at_the_providers_limit():
    many = MeetingContext(
        organisations=[f"term{i}" for i in range(KEYTERMS_MAX_UNIVERSAL_3 + 50)]
    )
    assert len(build_keyterms(many)) == KEYTERMS_MAX_UNIVERSAL_3
    assert len(build_keyterms(many, limit=KEYTERMS_MAX_UNIVERSAL_2)) == (
        KEYTERMS_MAX_UNIVERSAL_2
    )


def test_the_cap_is_far_above_the_hundred_it_used_to_be():
    """The old word_boost path stopped at 100 for no reason the provider gave."""
    assert KEYTERMS_MAX_UNIVERSAL_3 == 1000


# --- the builder ------------------------------------------------------------- #
def test_the_builder_returns_both_channels_under_one_limit():
    builder = TranscriptionContextBuilder(keyterms_limit=2)
    built = builder.build(
        MeetingContext(title="Sprint review", organisations=["A one", "B two", "C three"])
    )
    assert len(built.keyterms) == 2
    assert built.prompt and "Sprint review" in built.prompt


def test_the_builder_survives_a_meeting_it_knows_nothing_about():
    built = TranscriptionContextBuilder().build(None)
    assert built.prompt is None
    assert built.keyterms == []


def test_a_negative_limit_is_a_programming_error_not_a_silent_empty_list():
    with pytest.raises(ValueError):
        TranscriptionContextBuilder(keyterms_limit=-1)
