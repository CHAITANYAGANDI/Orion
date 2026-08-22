"""What Home offers to ask, and what changes it.

The chips on Home were generated entirely from whichever twelve meetings were
most recent, with a brief asking the model to "refer to real meetings and real
topics by name". Both halves are right for a meeting page and wrong for an
archive: a user whose only recent call was about product marketing was offered
"Key product feature announcements?" and "Competitive messaging framework?" as
the way into fifty unrelated meetings.

Home means "ask across my meeting memory". A chip there should be a question
about the archive.

The fix is not three hard-coded questions, which fails the other way — the same
row on every visit stops being read after the second. What is tested here is the
hybrid: signals the workspace actually has produce questions deterministically,
the model fills what is left, and a static floor covers a workspace that has
neither.
"""

from __future__ import annotations

from app.suggestions import STATIC_WORKSPACE, blend, signal_questions


# --- signals ---------------------------------------------------------------- #

def test_overdue_work_is_the_first_thing_offered():
    questions = signal_questions(overdue=4, open_items=9, decisions=3)

    assert questions[0] == "What overdue commitments need attention?"


def test_outstanding_work_is_offered_when_nothing_is_late_yet():
    questions = signal_questions(overdue=0, open_items=9)

    assert questions[0] == "What still needs to be completed?"


def test_nothing_is_offered_about_what_the_workspace_does_not_have():
    """A chip that answers itself teaches somebody the feature does not work."""
    assert signal_questions() == []
    assert "overdue" not in " ".join(signal_questions(open_items=3)).lower()
    assert signal_questions(decisions=0) == []


def test_a_recurring_project_becomes_a_question_about_it():
    questions = signal_questions(recurring="Q4 planning")

    # The one signal available without reading anything that says several
    # meetings are about the same work.
    assert "What changed in Q4 planning recently?" in questions


def test_a_project_named_after_a_sentence_cannot_take_the_row():
    questions = signal_questions(recurring="x" * 200)

    assert all(len(q) < 80 for q in questions)


# --- the blend --------------------------------------------------------------- #

def test_signals_come_before_anything_a_model_proposed():
    out = blend(["What overdue commitments need attention?"], ["Something generated"])

    # Grounded in a fact about the workspace, rather than in a model's reading
    # of twelve summaries.
    assert out[0] == "What overdue commitments need attention?"
    assert "Something generated" in out


def test_the_model_fills_what_the_signals_left():
    out = blend([], ["A", "B", "C", "D"])

    assert out == ["A", "B", "C"]


def test_the_static_floor_covers_a_workspace_with_neither():
    out = blend([], [])

    assert out == list(STATIC_WORKSPACE)


def test_the_same_question_is_never_offered_twice():
    # The model, asked for workspace-level questions, quite reasonably proposes
    # this one itself. Offering it twice is worse than offering two chips.
    out = blend(["What still needs to be completed?"], ["what still needs to be completed"])

    assert len(out) == 3
    assert out.count("What still needs to be completed?") == 1


def test_three_is_the_row():
    out = blend(["a?", "b?", "c?"], ["d?", "e?"])

    assert len(out) == 3


def test_every_chip_is_short_enough_to_read():
    out = blend(signal_questions(overdue=2, decisions=5, recurring="Billing"), [])

    assert all(len(q) <= 80 for q in out)
