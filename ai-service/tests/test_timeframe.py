"""Reading a time window out of a question.

Every failure here is silent. A window that fails to parse means the question
searches the whole archive and answers "what changed since last week?" from
March; a window parsed too eagerly means a question that meant to search
everything sees a month. Neither raises, and both produce a fluent answer.

The date is frozen so "last week" is a fixed interval rather than whatever the
suite happens to run on.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.timeframe import detect_window

NOW = datetime(2026, 8, 13, 14, 30, tzinfo=timezone.utc)  # a Thursday


def _w(question: str):
    return detect_window(question, NOW)


# --- when there is no window ------------------------------------------------ #
@pytest.mark.parametrize(
    "question",
    [
        "What did we decide about pricing?",
        "Who owns the migration?",
        "Summarize the Acme account.",
        "",
    ],
)
def test_a_question_without_a_period_gets_no_window(question):
    """The common case, and the one that matters most.

    Inventing a window here would hide most of the workspace from a question
    that meant to search all of it — and the user would never see that it had.
    """
    assert _w(question) is None


# --- rolling windows -------------------------------------------------------- #
def test_last_week_is_the_last_seven_days_not_the_previous_calendar_week():
    """A calendar reading puts yesterday's meeting outside "last week".

    Which is never what someone comparing recent work against older work means.
    """
    window = _w("What changed since last week?")
    assert window is not None
    assert window.start == NOW - timedelta(days=7)
    # Yesterday is inside it. Under a Monday-to-Sunday reading it would not be.
    assert window.start < NOW - timedelta(days=1)


@pytest.mark.parametrize(
    "question,days",
    [
        ("What happened this week?", 7),
        ("Anything from the past week?", 7),
        ("What came up last month?", 30),
        ("Decisions this month?", 30),
        ("How did last quarter go?", 91),
        ("What shipped this year?", 365),
        ("Anything in the last fortnight?", 14),
    ],
)
def test_bare_phrases_map_to_rolling_lengths(question, days):
    window = _w(question)
    assert window is not None
    assert window.start == NOW - timedelta(days=days)
    assert window.end is None


def test_an_explicit_count_wins_over_the_bare_phrase():
    """"last 3 weeks" must not be read as "last week".

    The bare pattern would match the same string, and the number would vanish
    silently — three weeks of evidence shrinking to seven days with nothing to
    show it happened.
    """
    window = _w("What have we agreed in the last 3 weeks?")
    assert window is not None
    assert window.start == NOW - timedelta(days=21)
    assert "3 week" in window.label


@pytest.mark.parametrize(
    "question,days",
    [
        ("the last 10 days", 10),
        ("past 2 months", 60),
        ("previous 1 year", 365),
    ],
)
def test_explicit_counts(question, days):
    window = _w(f"What changed in {question}?")
    assert window is not None
    assert window.start == NOW - timedelta(days=days)


def test_a_wildly_large_count_is_capped():
    """Guards the query, not the user: an unbounded interval is a full scan."""
    window = _w("What happened in the last 9000 months?")
    assert window is not None
    assert window.start >= NOW - timedelta(days=365 * 5)


def test_vague_recency_still_narrows():
    """"Lately" is imprecise, and a vague window still beats searching 1000
    meetings for a question that plainly meant recent ones."""
    window = _w("What have we been arguing about lately?")
    assert window is not None
    assert window.start == NOW - timedelta(days=30)


# --- calendar days and months ----------------------------------------------- #
def test_yesterday_is_a_calendar_day():
    """Nobody says "yesterday" meaning "the last 24 hours"."""
    window = _w("What did we decide yesterday?")
    assert window is not None
    assert window.start == datetime(2026, 8, 12, tzinfo=timezone.utc)
    assert window.end == datetime(2026, 8, 13, tzinfo=timezone.utc)


def test_today_starts_at_midnight_and_stays_open():
    window = _w("What have I got from today?")
    assert window is not None
    assert window.start == datetime(2026, 8, 13, tzinfo=timezone.utc)
    assert window.end is None


def test_in_a_named_month_is_that_month_alone():
    window = _w("What did we decide in March?")
    assert window is not None
    assert window.start == datetime(2026, 3, 1, tzinfo=timezone.utc)
    assert window.end == datetime(2026, 4, 1, tzinfo=timezone.utc)


def test_since_a_named_month_runs_to_now():
    window = _w("What has changed since March?")
    assert window is not None
    assert window.start == datetime(2026, 3, 1, tzinfo=timezone.utc)
    assert window.end is None


def test_a_month_still_ahead_this_year_means_last_year():
    """Asked in August, "since November" means last November.

    The other reading gives a window starting three months in the future, which
    matches no meeting at all — and reports that as "you have no meetings".
    """
    window = _w("What has changed since November?")
    assert window is not None
    assert window.start.year == 2025
    assert window.start.month == 11


def test_december_rolls_the_year_over():
    """The end boundary is month+1, which is 13 for December."""
    window = _w("What did we decide in December?")
    assert window is not None
    assert window.end == datetime(2026, 1, 1, tzinfo=timezone.utc)


# --- comparison ------------------------------------------------------------- #
@pytest.mark.parametrize(
    "question",
    [
        "What changed since last week?",
        "How is this month different from before?",
        "Compare this week to the last one.",
        "What progress have we made this month?",
        "Are we still blocked, versus last week?",
    ],
)
def test_comparison_questions_are_marked(question):
    """A comparison needs the meetings before the window too.

    Without both halves there is nothing for the answer to have changed from,
    and the model fills the gap by asserting that everything is new.
    """
    window = _w(question)
    assert window is not None
    assert window.comparative


@pytest.mark.parametrize(
    "question",
    [
        "What did we discuss last week?",
        "List the action items from this month.",
        "Who spoke in the meetings this week?",
    ],
)
def test_plain_lookups_are_not_comparisons(question):
    """Retrieving the older half here would spend half the context window on
    meetings the question excluded, and invite an answer about them."""
    window = _w(question)
    assert window is not None
    assert not window.comparative


def test_the_label_is_something_a_model_can_be_told():
    """It goes into the prompt and into the empty-result message, so it has to
    read as English rather than as a timestamp."""
    assert _w("What changed since last week?").label == "the last 7 days"
    assert _w("What did we decide yesterday?").label == "yesterday"
    assert _w("Anything in the last 3 days?").label == "the last 3 days"
    assert _w("Anything in the last 1 day?").label == "the last 1 day"
