"""Which of a speaker's turns go into their voiceprint.

The embedder itself needs torch and is exercised end to end against real audio
(see `docs/speaker-identification.md` for the measurements). This is the part in
front of it, which is pure arithmetic over turn boundaries and decides what the
model is actually shown — and getting it wrong degrades matching quietly, in a
way no exception ever reports.

Two mistakes are worth naming because both are the obvious implementation.

**Taking the first N seconds.** Over-weights whatever happened at the top of the
meeting, which is often somebody reading an agenda in a different register from
the rest of their contribution. It also means a person who says "morning" and
then nothing for ten minutes contributes one word.

**Taking every turn.** A one-word interjection carries almost no speaker
information, and at a handover it is disproportionately likely to be the tail of
the *previous* speaker's word — so it drags the average toward whoever they were
talking to. Diarization is at its least certain exactly where turns are shortest.

So: longest turns first, up to a cap, then back into chronological order.
"""

from __future__ import annotations

from app.providers.ecapa_embedder import (
    MAX_SPAN_SECONDS,
    MIN_SPAN_SECONDS,
    SAMPLE_RATE,
    choose_spans,
)


def test_the_model_is_fed_at_the_rate_it_was_trained_on():
    # Not a quality trade-off. ECAPA-TDNN was trained at 16 kHz, and feeding it
    # anything else moves the filterbank centres — it is a different signal.
    assert SAMPLE_RATE == 16_000


def test_substantial_turns_are_preferred_over_early_ones():
    picked = choose_spans([
        (0.0, 2.0),     # early, short
        (10.0, 50.0),   # late, long
    ], max_total=20.0)

    # The long one wins the budget outright. Taking the first 20 seconds instead
    # would have spent most of it on two seconds of speech and silence.
    assert picked.spans == [(10.0, 30.0)]


def test_the_chosen_turns_come_back_in_time_order():
    picked = choose_spans([(60.0, 90.0), (5.0, 45.0), (100.0, 112.0)], max_total=90.0)

    assert picked.spans == sorted(picked.spans)


def test_a_one_word_interjection_is_not_used():
    picked = choose_spans([(0.0, 0.4), (1.0, 1.3), (5.0, 25.0)])

    # "Exactly." is where diarization is least certain and where a turn is most
    # likely to contain the end of somebody else's word.
    assert picked.spans == [(5.0, 25.0)]
    assert picked.seconds == 20.0


def test_the_floor_is_a_floor_and_not_a_rounding():
    just_under = choose_spans([(0.0, MIN_SPAN_SECONDS - 0.01)])
    just_over = choose_spans([(0.0, MIN_SPAN_SECONDS + 0.01)])

    assert just_under.spans == []
    assert len(just_over.spans) == 1


def test_a_long_speaker_is_capped_rather_than_embedded_whole():
    picked = choose_spans([(0.0, 3600.0)])

    # Past roughly this much speech the embedding stops improving, and an
    # hour-long monologue would cost a minute of CPU to say the same thing.
    assert picked.seconds == MAX_SPAN_SECONDS
    assert picked.spans == [(0.0, MAX_SPAN_SECONDS)]


def test_the_cap_is_reached_by_trimming_the_last_turn_not_dropping_it():
    picked = choose_spans([(0.0, 30.0), (40.0, 70.0)], max_total=45.0)

    # 30 + 15, not 30 alone. Discarding the whole second turn would throw away
    # the recording conditions that make an average worth having.
    assert picked.seconds == 45.0
    assert picked.spans == [(0.0, 30.0), (40.0, 55.0)]


def test_a_speaker_with_nothing_usable_yields_nothing_rather_than_raising():
    # An ordinary outcome: that speaker stays unresolved, which is what the
    # matcher would have decided anyway once it saw the duration.
    assert choose_spans([]).spans == []
    assert choose_spans([(0.0, 0.1), (1.0, 1.05)]).spans == []


def test_a_zero_or_reversed_span_is_ignored():
    # Segment edits and merges can leave these behind. Treating one as a
    # negative duration would corrupt the running total.
    assert choose_spans([(5.0, 5.0), (9.0, 3.0), (10.0, 30.0)]).spans == [(10.0, 30.0)]


def test_the_reported_duration_matches_what_was_selected():
    picked = choose_spans([(0.0, 12.0), (20.0, 29.0)])

    # The matcher refuses a candidate built from too little speech, and it reads
    # this number rather than re-deriving it from segments that may since have
    # been edited. It has to be the duration actually embedded.
    assert picked.seconds == sum(end - start for start, end in picked.spans)
    assert picked.seconds == 21.0
