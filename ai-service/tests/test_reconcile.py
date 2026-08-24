"""The join between AssemblyAI's words and the diarizer's timeline.

Everything here is a pure function of (words, timeline), which is the point of
the design: the behaviour that matters is at boundaries, and boundaries can be
tested exhaustively with constructed times instead of sampled with audio.
"""

from __future__ import annotations

from app.diarize_port import SpeakerTurn, Timeline
from app.reconcile import AMBIGUOUS, BELOW_FLOOR, SILENT, assign, trace


def timeline(*turns: tuple[float, float, str], model: str = "test") -> Timeline:
    return Timeline(
        turns=[SpeakerTurn(s, e, who) for s, e, who in turns],
        model=model,
    )


def words(*spec: tuple[str, float, float, str | None]):
    return list(spec)


# --------------------------------------------------------------- invariants --

def test_the_words_themselves_are_never_touched():
    """§14: text, timings and count survive reconciliation exactly.

    This is the line between diarization and transcription. A join that edited a
    word would be a transcription change wearing a diarization label, and the
    provider — not this module — is canonical for what was said.
    """
    given = words(
        ("Hello", 0.0, 0.4, "A"),
        ("there", 0.4, 0.9, "A"),
        ("mate.", 0.9, 1.5, "A"),
    )
    result = assign(given, timeline((0.0, 0.7, "D0"), (0.7, 1.5, "D1")))

    assert len(result.verdicts) == len(given)
    for original, verdict in zip(given, result.verdicts):
        text, start, end, _ = original
        assert (verdict.text, verdict.start, verdict.end) == (text, start, end)


def test_the_providers_own_label_is_kept_beside_the_new_one():
    """§3/§12: raw stays for diagnosis, and for the identity pass afterwards."""
    result = assign(words(("Hi", 0.0, 0.5, "B")), timeline((0.0, 1.0, "D0")))
    assert result.verdicts[0].raw == "B"
    assert result.verdicts[0].cluster == "D0"
    assert result.verdicts[0].key == "spk_1"


# ------------------------------------------------------------ max overlap ---

def test_a_word_goes_to_whoever_said_most_of_it_not_to_whoever_starts_it():
    """The heart of §3, and the reason a start-timestamp lookup is wrong.

    This word begins 40ms inside D0 and spends the remaining 360ms in D1. Word
    timings and diarization boundaries come from two different models and never
    agree to the millisecond, so "look up the speaker at word.start" is wrong
    precisely at boundaries — which is where all the errors are.
    """
    result = assign(
        words(("boundary", 0.96, 1.36, "A")),
        timeline((0.0, 1.0, "D0"), (1.0, 2.0, "D1")),
    )
    assert result.verdicts[0].cluster == "D1"


def test_an_evenly_split_word_is_left_unresolved_rather_than_guessed():
    """Neither side holds enough of it. A coin toss is what unresolved avoids."""
    result = assign(
        words(("split", 0.80, 1.20, "A")),
        timeline((0.0, 1.0, "D0"), (1.0, 2.0, "D1")),
    )
    assert result.verdicts[0].key is None
    assert result.verdicts[0].reason


def test_a_word_outside_every_turn_is_unresolved_in_strict_mode():
    result = assign(
        words(("stray", 5.0, 5.4, "A")),
        timeline((0.0, 1.0, "D0")),
        fall_back_to_provider=False,
    )
    assert result.verdicts[0].key is None
    assert result.verdicts[0].reason_code == SILENT
    assert "outside" in result.verdicts[0].reason


# ------------------------------------------------------- silence vs doubt ---

def test_silence_is_not_a_verdict_so_the_provider_keeps_the_word():
    """The rule the real recording forced.

    Community-1 reported no speech across a third of a phone call the provider
    transcribed continuously. Reading that silence as disagreement threw away
    the speaker of a quarter of the words, which is worse than what ships
    today. Where the diarizer says nothing, the provider stands.
    """
    result = assign(
        words(
            ("Definitely", 0.0, 0.9, "A"),
            ("mine", 10.0, 10.9, "B"),
            ("again", 30.0, 30.9, "A"),   # nothing diarized out here
        ),
        timeline((0.0, 1.0, "D0"), (10.0, 11.0, "D1")),
    )
    assert [v.key for v in result.verdicts] == ["spk_1", "spk_2", "spk_1"]
    assert result.verdicts[2].from_provider
    assert result.provider_fallbacks == 1
    # And the silence is still reported, because an operator wants to know the
    # model could not hear a third of the meeting even though it looks fine.
    assert result.verdicts[2].reason_code == SILENT
    assert result.silent_seconds > 0


def test_an_ambiguous_boundary_never_falls_back():
    """The distinction the whole rule turns on.

    Here the diarizer *did* hear speech and could not say whose. Handing the
    word back to the provider would return exactly the boundary the diarizer
    was brought in to second-guess.
    """
    result = assign(
        words(("split", 0.80, 1.20, "A")),
        timeline((0.0, 1.0, "D0"), (1.0, 2.0, "D1")),
    )
    assert result.verdicts[0].key is None
    assert result.verdicts[0].reason_code == AMBIGUOUS
    assert result.provider_fallbacks == 0


def test_a_rejected_cluster_never_falls_back_either():
    """The phantom guard heard something and distrusted it. Still not silence."""
    result = assign(
        words(
            ("talking", 0.0, 3.0, "A"),
            ("--", 3.05, 3.20, "A"),
            ("onwards", 3.3, 6.0, "A"),
        ),
        timeline((0.0, 3.02, "D0"), (3.02, 3.22, "D9"), (3.22, 6.0, "D0")),
    )
    assert result.verdicts[1].key is None
    assert result.verdicts[1].reason_code == BELOW_FLOOR
    assert result.provider_fallbacks == 0


def test_the_provider_label_is_translated_by_overlap_not_by_its_number():
    """"Speaker 2" is not spk_2 just because of the digit in it.

    The two systems number speakers in whatever order they meet them, and the
    orders need not agree. Here the provider's second label belongs to the
    voice the diarizer heard first.
    """
    result = assign(
        words(
            ("first", 0.0, 0.9, "Speaker 2"),
            ("second", 10.0, 10.9, "Speaker 1"),
            ("later", 30.0, 30.9, "Speaker 2"),  # silent region
        ),
        timeline((0.0, 1.0, "D0"), (10.0, 11.0, "D1")),
    )
    assert result.verdicts[0].key == "spk_1"
    assert result.verdicts[2].key == "spk_1", "translated by time, not by label"


def test_a_speaker_the_diarizer_never_heard_keeps_a_key_of_its_own():
    """Never folded into somebody else: merging two people is unrecoverable."""
    result = assign(
        words(
            ("hello", 0.0, 0.9, "Speaker 1"),
            ("nowhere", 30.0, 30.9, "Speaker 3"),
        ),
        timeline((0.0, 1.0, "D0")),
    )
    keys = [v.key for v in result.verdicts]
    assert keys[0] == "spk_1"
    assert keys[1] is not None and keys[1] != keys[0]


def test_a_zero_length_token_uses_the_instant_it_sits_at():
    """Providers emit punctuation-only tokens with no span to share out."""
    result = assign(
        words((",", 1.5, 1.5, "A")),
        timeline((0.0, 1.0, "D0"), (1.0, 2.0, "D1")),
    )
    assert result.verdicts[0].cluster == "D1"


# --------------------------------------------------------- the brief's case --

def test_the_worked_example_from_the_brief():
    """§3, verbatim: one-word interjection between two turns of the same voice."""
    result = assign(
        words(
            ("I'm", 0.00, 0.20, "A"),
            ("done.", 0.20, 0.60, "A"),
            ("Exactly.", 0.61, 1.05, "A"),
            ("Let's", 1.06, 1.25, "A"),
        ),
        timeline((0.00, 0.60, "D0"), (0.60, 1.06, "D1"), (1.06, 2.00, "D0")),
    )
    assert [v.key for v in result.verdicts] == ["spk_1", "spk_1", "spk_2", "spk_1"]
    # The provider called all four words one voice; two boundaries were found
    # inside that one label.
    assert result.repaired_boundaries == 2


# ------------------------------------------------------------- global keys --

def test_the_same_cluster_keeps_the_same_key_across_the_whole_recording():
    """§4: no per-sentence nearest-neighbour. One clustering, one answer."""
    result = assign(
        words(
            ("a", 0.0, 0.9, "A"),
            ("b", 10.0, 10.9, "A"),
            ("c", 20.0, 20.9, "A"),
            ("d", 30.0, 30.9, "A"),
        ),
        timeline(
            (0.0, 1.0, "D0"), (10.0, 11.0, "D1"),
            (20.0, 21.0, "D0"), (30.0, 31.0, "D1"),
        ),
    )
    keys = [v.key for v in result.verdicts]
    assert keys == ["spk_1", "spk_2", "spk_1", "spk_2"]


def test_keys_are_numbered_by_first_appearance_not_by_cluster_name():
    """D7 speaking first is Speaker 1. Cluster ids carry no order."""
    result = assign(
        words(("first", 0.0, 0.9, "A"), ("second", 5.0, 5.9, "A")),
        timeline((0.0, 1.0, "D7"), (5.0, 6.0, "D2")),
    )
    assert [v.key for v in result.verdicts] == ["spk_1", "spk_2"]


# ------------------------------------------------------ the phantom guard ---

def test_a_brief_recurring_voice_is_a_speaker():
    """Somebody who only ever says "yes" three times is in the room."""
    result = assign(
        words(
            ("So", 0.0, 2.0, "A"),
            ("yes", 2.1, 2.35, "A"),
            ("and", 2.5, 4.0, "A"),
            ("yes", 4.1, 4.35, "A"),
        ),
        timeline(
            (0.0, 2.05, "D0"), (2.05, 2.40, "D1"),
            (2.45, 4.05, "D0"), (4.05, 4.40, "D1"),
        ),
    )
    # 0.7s total, but heard twice. Recurrence is what earns it a place.
    assert [v.key for v in result.verdicts] == ["spk_1", "spk_2", "spk_1", "spk_2"]


def test_a_single_brief_artefact_is_not_a_speaker():
    """One isolated fragment, heard once, and short. That is the shape to drop."""
    result = assign(
        words(
            ("talking", 0.0, 3.0, "A"),
            ("--", 3.05, 3.20, "A"),
            ("onwards", 3.3, 6.0, "A"),
        ),
        timeline((0.0, 3.02, "D0"), (3.02, 3.22, "D9"), (3.22, 6.0, "D0")),
    )
    assert result.rejected_clusters == 1
    assert result.verdicts[1].key is None
    assert "floor" in result.verdicts[1].reason
    # And its audio is not handed to a neighbour, which is the phantom arriving
    # one step later.
    assert [v.key for v in result.verdicts] == ["spk_1", None, "spk_1"]


def test_a_monologue_is_never_split():
    result = assign(
        words(*[(f"w{i}", i * 0.5, i * 0.5 + 0.45, "A") for i in range(60)]),
        timeline((0.0, 30.0, "D0")),
    )
    assert {v.key for v in result.verdicts} == {"spk_1"}
    assert result.repaired_boundaries == 0


# ------------------------------------------------------------- degradation --

def test_an_unavailable_timeline_degrades_to_exactly_the_provider():
    """A missing model must not cost a meeting its speakers.

    No weights, a broken download, no HF token: the transcript still has the
    provider's segmentation, which is what shipped before any of this existed.
    The diarizer contributes nothing and invents nothing.
    """
    result = assign(
        words(
            ("Morning", 0.0, 0.5, "Speaker 1"),
            ("all", 1.0, 1.5, "Speaker 2"),
            ("again", 2.0, 2.5, "Speaker 1"),
        ),
        Timeline(turns=[], model="none", unavailable="no weights"),
    )
    assert result.diarizer_speakers == 0
    assert [v.cluster for v in result.verdicts] == [None, None, None]
    keys = [v.key for v in result.verdicts]
    assert keys[0] == keys[2] and keys[0] != keys[1], "the provider's two speakers, kept"
    assert result.provider_fallbacks == 3
    assert result.repaired_boundaries == 0, "a silent model repairs nothing"


def test_strict_mode_still_resolves_nothing_without_a_timeline():
    result = assign(
        words(("hello", 0.0, 0.5, "A")),
        Timeline(turns=[], model="none", unavailable="no weights"),
        fall_back_to_provider=False,
    )
    assert result.verdicts[0].key is None
    assert result.diarizer_speakers == 0


# -------------------------------------------------------------- telemetry ---

def test_production_telemetry_carries_counts_and_no_content():
    """§12: never transcript text in anything a deployment may emit."""
    result = assign(
        # Distinctive texts: "words" would collide with the count field of the
        # same name and make this pass or fail for the wrong reason.
        words(("Pemberton", 0.0, 0.5, "A"), ("Featherstonehaugh", 0.6, 1.0, "A")),
        timeline((0.0, 0.55, "D0"), (0.55, 1.0, "D1")),
    )
    emitted = result.telemetry()
    blob = repr(emitted)
    assert "Pemberton" not in blob and "Featherstonehaugh" not in blob
    assert emitted["provider_speakers"] == 1
    assert emitted["diarizer_speakers"] == 2


def test_the_developer_trace_shows_all_three_opinions():
    """§12: time, word, provider label, diarizer cluster, final key."""
    result = assign(
        words(("home.", 25.03, 25.14, "B"), ("All", 25.14, 25.40, "B")),
        timeline((20.0, 25.14, "D1"), (25.14, 30.0, "D0")),
    )
    lines = trace(result)
    assert "AAI=B" in lines[0] and "diar=D1" in lines[0]
    assert "AAI=B" in lines[1] and "diar=D0" in lines[1]
    assert lines[0].split("final=")[1] != lines[1].split("final=")[1]
