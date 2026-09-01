"""Which question is which, and what each one is allowed to draw on.

The router decides two things and this file is the table for both: the intent
(what shape the answer takes) and the knowledge policy (where the answer may get
its material). Every other test in the suite assumes this table is right.

## The distinction that needed adding

    "What is Tech in Asia Conference 2025?"          explain
    "What did they say about the conference?"        fact

Both are `what` questions about the same entity and they want opposite things.
The second asks what this recording contains and is answerable only from it. The
first asks the reader's actual question — *what is this thing* — and answering it
with a paraphrase of forty-seven seconds of promotional speech is a search
engine's answer, not an assistant's.

Reverie classified both as `fact`, so both got the meeting-only policy, so the
first came back as a one-paragraph restatement of the transcript. It was
accurate, grounded, and not what was asked.

## Why the boundary is drawn where it is

An explanatory question names a *thing* and asks what it is or does. A factual
question names the *conversation* — who said it, when they said it, what was
decided, what figure was quoted. The discriminators are therefore lexical and
narrow:

* an article followed by a lower-case noun ("the registration URL", "the
  deadline") is a meeting fact, not an entity to explain;
* anything referring to the recording ("mentioned", "in the meeting", "did they
  say") is a meeting question whatever frame it wears.

A misclassification is recoverable in both directions and neither is silent. An
explanatory question read as fact gives the terse answer that prompted this. A
factual question read as explain still cannot invent — `_EXPLANATORY_BACKGROUND`
forbids every event-specific fact — so it costs a paragraph of background.
"""

from __future__ import annotations

import pytest

from app.questions import INTENTS, Knowledge, classify, knowledge_policy


# --- explanatory ------------------------------------------------------------- #

EXPLAIN = [
    "What is the Tech in Asia Conference 2025?",
    "What is Tech in Asia Conference 2025?",
    "What is Kubernetes?",
    "What is RAG?",
    "What is Stripe?",
    "What does Kafka do?",
    "What does pgvector do?",
    "Explain OAuth.",
    "Explain retrieval augmented generation.",
    "Tell me about Tech in Asia Conference 2025.",
    "What exactly is AssemblyAI?",
]


@pytest.mark.parametrize("question", EXPLAIN)
def test_an_explanatory_question_is_classified_explain(question):
    assert classify(question) == "explain"


@pytest.mark.parametrize("question", EXPLAIN)
def test_an_explanatory_question_may_use_background(question):
    assert knowledge_policy(classify(question)) is Knowledge.EXPLANATORY_BACKGROUND


# --- about the meeting, and staying that way --------------------------------- #

ABOUT_THE_MEETING = [
    "What did they say about Kubernetes?",
    "What did Sarah say about Stripe?",
    "What price did they mention?",
    "What is the URL mentioned in the meeting?",
    "When did they say the conference starts?",
    "Who mentioned Kafka?",
    "What deadline did we agree?",
    "What features did John list?",
    "What was decided about OAuth?",
    "What is the registration URL?",
    "What does registration cost?",
    "When does registration close?",
]


@pytest.mark.parametrize("question", ABOUT_THE_MEETING)
def test_a_question_about_the_recording_is_never_explain(question):
    assert classify(question) != "explain", question


@pytest.mark.parametrize("question", ABOUT_THE_MEETING)
def test_a_question_about_the_recording_is_answered_from_it_alone(question):
    # The assertion that matters. "What features did John list?" is an inventory
    # rather than a lookup, and the intent it lands on is less important than
    # this: none of these may reach past the user's own evidence.
    assert knowledge_policy(classify(question)) is Knowledge.MEETING_ONLY, question


MANDATED_FACT = [
    "What did they say about Kubernetes?",
    "What price did they mention?",
    "When did they say the conference starts?",
    "What is the registration URL mentioned in the meeting?",
]


@pytest.mark.parametrize("question", MANDATED_FACT)
def test_the_named_lookups_are_fact(question):
    assert classify(question) == "fact", question


def test_when_did_they_say_is_a_lookup_and_not_a_chronology():
    """`when did` used to route to `timeline`, which is a different answer.

    A timeline is how something developed, ordered, with dates. "When did they
    say the conference starts?" wants one date the meeting stated. Genuine
    chronologies still route correctly on their own words.
    """
    assert classify("When did they say the conference starts?") == "fact"
    assert classify("When did we decide to use Deepgram?") == "fact"

    assert classify("What is the timeline for the migration?") == "timeline"
    assert classify("How did the pricing decision change over time?") == "timeline"
    assert classify("In what order did those land?") == "timeline"


# --- the policies stay three, and stay apart --------------------------------- #

def test_there_are_exactly_three_knowledge_policies():
    assert {p for p in Knowledge} == {
        Knowledge.MEETING_ONLY,
        Knowledge.PROCEDURAL_GUIDANCE,
        Knowledge.EXPLANATORY_BACKGROUND,
    }


def test_each_intent_has_exactly_one_policy():
    by_policy: dict[Knowledge, set[str]] = {}
    for intent in INTENTS:
        by_policy.setdefault(knowledge_policy(intent), set()).add(intent)

    assert by_policy[Knowledge.PROCEDURAL_GUIDANCE] == {"how_to", "compose"}
    assert by_policy[Knowledge.EXPLANATORY_BACKGROUND] == {"explain"}
    # Everything else, which is most of them and must stay that way.
    assert by_policy[Knowledge.MEETING_ONLY] == {
        "fact", "inventory", "timeline", "comparison", "summary", "synthesis",
    }


def test_procedural_and_explanatory_are_not_the_same_permission():
    """Collapsing both into `guidance=True` is the shortcut this rules out.

    They permit different things. A procedural answer may describe the usual
    steps of a process; an explanatory one may describe what a kind of thing is
    for. Neither may do the other's job, and a single boolean cannot say so.
    """
    assert knowledge_policy("how_to") is not knowledge_policy("explain")
    assert knowledge_policy("how_to") is Knowledge.PROCEDURAL_GUIDANCE
    assert knowledge_policy("explain") is Knowledge.EXPLANATORY_BACKGROUND


def test_the_default_is_the_strict_one():
    """An intent added later and forgotten here must not gain a permission."""
    assert knowledge_policy("something_invented_next_year") is Knowledge.MEETING_ONLY
    assert knowledge_policy("") is Knowledge.MEETING_ONLY
