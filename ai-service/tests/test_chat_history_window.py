"""How far back the workspace chat is allowed to read.

An account can put a floor under retrieval — every meeting, or only the last
year, or the last three months. The value is not privacy: nothing is hidden,
deleted or made unreadable, and the meeting's own page still answers about it.
It is that a workspace with three years of standups answers "what did we decide
about pricing" better when the answer is not competing with a decision that was
reversed eighteen months ago.

The failure worth guarding is the quiet one: a floor that is not applied looks
identical to a floor that is, until somebody notices an answer citing a meeting
they thought was out of scope.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.rag import _history_floor
from app.schemas import WorkspaceChatRequest


def test_no_window_means_no_floor():
    # None, not "now minus zero" — the SQL predicate is skipped entirely, which
    # is what every caller got before the setting existed.
    assert _history_floor(None) is None


def test_a_window_becomes_a_cutoff_that_many_days_back():
    floor = _history_floor(90)

    assert floor is not None
    expected = datetime.now(timezone.utc) - timedelta(days=90)
    # A second of slack: the clock is read inside the function.
    assert abs((floor - expected).total_seconds()) < 5


def test_the_cutoff_is_timezone_aware():
    # `meetings.created_at` is TIMESTAMPTZ. A naive datetime would compare
    # against it as if it were UTC on some drivers and raise on others.
    floor = _history_floor(30)

    assert floor is not None and floor.tzinfo is not None


def test_a_nonsense_window_reads_everything_rather_than_nothing():
    # Zero or negative would otherwise put the floor at or after now, and the
    # chat would answer "I couldn't find anything" about a full archive.
    assert _history_floor(0) is None
    assert _history_floor(-5) is None


def test_the_request_defaults_to_reading_everything():
    body = WorkspaceChatRequest(userId="usr_1", question="Where does ABC stand?")

    assert body.history_days is None


def test_the_request_carries_the_window_spring_resolved():
    body = WorkspaceChatRequest(
        userId="usr_1", question="Where does ABC stand?", historyDays=365
    )

    assert body.history_days == 365
