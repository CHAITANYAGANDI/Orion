"""The second bug report: correct, grounded, and no use to anybody.

A speech about a conference was uploaded. It says, in full, that the event
brings founders, product professionals, corporate leaders and investors together
with curated programs and new passes, that networking has never been simpler,
and to register now. It contains no link, no price, no date and no instructions.

    Q. "How can I register for the Tech in Asia Conference 2025 mentioned in
        the speech?"
    A. "Register through the Tech in Asia Conference 2025 registration process
        referenced in the speech; it says to 'Register now,' but does not
        provide a URL or specific steps."

Nothing in that is wrong. It leads with the answer, it narrates no retrieval, it
invents nothing, and the reader is exactly where they started — because the
question was never answerable from a transcript. "How do I register" is a
question about the world; the transcript can only say that registering is a
thing the speaker mentioned.

So the fix is not a better sentence. It is admitting that an answer has two
knowledge classes and that a meeting assistant which can only produce one of
them is half a product:

    meeting-sourced    what was said, decided, owed, quoted, priced, dated
    general guidance   how a thing of this kind is ordinarily done

The tests here are about the boundary between them, in both directions. The
permissive direction is one test; the strict direction is four, because that is
where the damage is. A procedure offered where none was wanted is a paragraph
somebody skims. A price invented for "what did it cost?" is indistinguishable
from a real one to the person about to spend it.

There is no model in these tests, so what is asserted is the *policy* — what was
classified, what was permitted, what brief was sent, and what happens to the
citations of an answer that mixes the two. The prose is verified live against
the real meeting; see the report accompanying this change.
"""

from __future__ import annotations

import asyncio

from app import answering, questions
from app.answering import MEETING_ONLY, MIXED, Answer
from app.questions import Knowledge
from app.rag import RagService
from tests.conftest import rag_settings


# --- the fixture ------------------------------------------------------------- #

SPEECH = (
    "Speaker 1: The Tech in Asia Conference 2025 brings founders, product "
    "professionals, corporate leaders and investors together with curated "
    "programs and new passes. Networking has never been simpler. Register now."
)

# Distance is the measured band for a question the corpus does answer — the
# transcript genuinely is about this conference, so the passage clears the
# relevance gate and the answer has something to be grounded in.
TRANSCRIPT = [(0, SPEECH, 0.0, 47.0, 0.61)]

REGISTER = "How can I register for the Tech in Asia Conference 2025 mentioned in the speech?"


class _Llm:
    """Records the brief it was handed. Returns whatever the test needs back."""

    def __init__(self, answer: Answer | None = None) -> None:
        self.context: list[str] | None = None
        self.kwargs: dict = {}
        self.system: str = ""
        self._answer = answer or Answer(text="An answer.", used=(1,))

    async def answer(self, question, context, *, exhaustive=False, **kw):
        self.context = context
        self.kwargs = kw
        # The brief the adapter would build from these arguments. Assembled here
        # rather than reaching into the adapter so the test exercises the same
        # path the OpenAI adapter takes: question -> policy -> prompt.
        self.system = answering.system_prompt(
            intent=kw.get("intent", "fact"),
            depth=kw.get("depth", "express"),
            exhaustive=exhaustive,
            policy=kw.get("policy", Knowledge.MEETING_ONLY),
        )
        return self._answer


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, params=None):
        return None

    async def fetchall(self):
        return self._rows

    async def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return _Cursor(self._rows)


class _Embedder:
    async def embed(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]


def _service(rows=None, llm=None):
    service = RagService.__new__(RagService)
    llm = llm or _Llm()

    class _Ctx:
        async def __aenter__(self):
            return _Conn(TRANSCRIPT if rows is None else rows)

        async def __aexit__(self, *exc):
            return False

    service.connection = lambda user_id=None: _Ctx()  # type: ignore[assignment]
    service._pool = object()  # type: ignore[attr-defined]
    service._embedder = _Embedder()  # type: ignore[attr-defined]
    service._llm = llm  # type: ignore[attr-defined]
    service._settings = rag_settings()  # type: ignore[attr-defined]
    return service, llm


def _ask(service, question, mode="express"):
    return asyncio.run(service.answer("mtg_talk", question, "usr_1", mode))


# --- the classifier, stated as a table ---------------------------------------- #
#
# The spelling matters as much as the behaviour. The intent shipped as `howto`,
# which meant a reader grepping the agreed name — `how_to` — found nothing and
# reasonably concluded the intent had never been added. It is `how_to`
# everywhere now, and this table is where that is pinned.

HOW_TO_QUESTIONS = [
    "How can I register for the Tech in Asia Conference 2025 mentioned in the speech?",
    "How do I register?",
    "What should I do next?",
    "How should I follow up?",
    "How can we implement this?",
    "How do I apply?",
    "What steps should I take?",
    "How should I prepare for this?",
]

# Every one of these is a value the meeting either records or does not. Routing
# any of them to how_to would licence a plausible invented answer, which is the
# one failure worse than an unhelpful one.
FACT_QUESTIONS = [
    "What is the registration URL?",
    "What does registration cost?",
    "When is the conference?",
    "Who is organizing it?",
    "What did Sarah say?",
    "When does registration close?",
]


def test_a_procedural_question_is_classified_how_to():
    for question in HOW_TO_QUESTIONS:
        assert questions.classify(question) == "how_to", question


def test_a_factual_question_is_never_classified_how_to():
    for question in FACT_QUESTIONS:
        assert questions.classify(question) == "fact", question


def test_the_intent_is_spelled_how_to():
    """Not `howto`. The name is part of the contract with whoever reads this."""
    assert "how_to" in questions.INTENTS
    assert "howto" not in questions.INTENTS
    assert "how_to" in answering._INTENT


# --- the permissive direction ------------------------------------------------ #

def test_the_registration_question_is_recognised_as_a_procedure():
    """The whole fix turns on this one bit.

    Classified as a lookup, the question gets the strict brief and the reply
    that shipped. Everything downstream — the two-part answer, the labelled
    steps, the hedging — hangs off `how_to` being the intent.
    """
    assert questions.classify(REGISTER) == "how_to"
    assert questions.knowledge_policy("how_to") is Knowledge.PROCEDURAL_GUIDANCE


def test_the_meeting_evidence_still_reaches_the_model():
    """Guidance supplements evidence; it never replaces it.

    An answer that skips straight to general steps has stopped being a meeting
    assistant. The speech says "Register now", and that is the sentence the
    first half of the answer is built on.
    """
    service, llm = _service()

    _ask(service, REGISTER)

    assert llm.context is not None
    assert "Register now" in " ".join(llm.context)


def test_the_procedural_brief_permits_general_steps_and_bounds_them():
    service, llm = _service()

    _ask(service, REGISTER)
    brief = llm.system

    assert llm.kwargs["policy"] is Knowledge.PROCEDURAL_GUIDANCE
    # Meeting first, then guidance, and the reader can tell which is which.
    assert "FIRST, what the meetings support" in brief
    assert "THEN, general guidance" in brief
    assert "cannot be read as something somebody said" in brief
    # The bound. Procedure may be general; a fact may not.
    assert "Guidance is procedure, never fact" in brief
    assert "no URL or web address, no price, no date" in brief
    # Hedged, because we do not know that this event works the usual way.
    assert '"if required"' in brief
    assert "definitely part of it" in brief


def test_both_modes_can_answer_a_procedural_question():
    """Express is not the mode that answers badly.

    A user on the cheaper setting asking how to do something gets the same
    two-part answer, more briefly. Making usefulness a paid feature would be a
    worse bug than the one being fixed.
    """
    for mode in ("express", "advanced"):
        service, llm = _service()
        _ask(service, REGISTER, mode=mode)

        assert llm.kwargs["policy"] is Knowledge.PROCEDURAL_GUIDANCE, mode
        assert "THEN, general guidance" in llm.system, mode

    # And they still differ in what they read and how much they write.
    procedural = Knowledge.PROCEDURAL_GUIDANCE
    assert "Be concise but complete" in answering.system_prompt(
        intent="how_to", depth="express", policy=procedural)
    assert "Go deeper" in answering.system_prompt(
        intent="how_to", depth="advanced", policy=procedural)


def test_the_reader_is_never_shown_the_vocabulary_of_the_pipeline():
    """"The passage does not state a date" is a true sentence about machinery.

    A reader looking at a recording of a conversation they sat in has no idea
    what a passage is. The same answer says "the transcript doesn't give a
    date", which is the same claim in words that exist for them.
    """
    for intent in questions.INTENTS:
        brief = answering.system_prompt(
            intent=intent, policy=questions.knowledge_policy(intent)
        )
        assert 'Never "the passage"' in brief
        assert 'Call the source "the meeting"' in brief
        # And the rest of the pipeline's vocabulary, named so there is no
        # ambiguity about which words are meant.
        for word in ("vector search", "embedding", "chunk", "top-k", "ranking"):
            assert word in brief


def test_no_answer_may_claim_a_capability_orion_does_not_have():
    """The reference product offers to search the web. We cannot.

    An answer that has just admitted the transcript lacks a link is one sentence
    away from offering to look it up, and the reader would wait for it.
    """
    for policy in Knowledge:
        brief = answering.system_prompt(intent="how_to", policy=policy)
        assert "You cannot browse, search the web, open a link" in brief
        assert "look up anything current" in brief
        assert "Never offer to look something up" in brief


def test_guidance_never_arrives_without_the_grounding_rules():
    """The permissive block is an addition, never a substitution."""
    brief = answering.system_prompt(
        intent="how_to", policy=Knowledge.PROCEDURAL_GUIDANCE)

    assert "Every claim about these meetings comes from the passages" in brief
    assert "Never invent a fact" in brief
    assert "ANSWER FIRST" in brief


# --- explaining a thing ------------------------------------------------------- #
#
# The third policy, and the one that is easiest to get wrong in the direction
# nobody notices. A procedure invented for a conference nobody attended is
# obviously generic. A *feature* invented for one — "VIP passes", "pitch
# stages" — reads exactly like a fact, on a page whose whole promise is that
# facts come from the recording.

WHAT_IS = "What is the Tech in Asia Conference 2025?"


def test_the_explanatory_question_is_recognised_as_one():
    assert questions.classify(WHAT_IS) == "explain"
    assert questions.knowledge_policy("explain") is Knowledge.EXPLANATORY_BACKGROUND


def test_the_explanatory_brief_reaches_the_real_adapter():
    """Not a stand-in. The prompt asserted here is the one the adapter built."""
    capture = _CapturingAdapter()
    service, _ = _service(llm=capture)

    asyncio.run(service.answer("mtg_talk", WHAT_IS, "usr_1", "express"))

    brief = capture.system or ""
    assert "This question asks what something IS" in brief
    assert "THEN, general background" in brief
    # And the meeting's own words went with it — background supplements the
    # evidence and never replaces it.
    assert "curated programs" in (capture.user or "")


def test_the_explanatory_brief_permits_background_and_bounds_it():
    brief = answering.system_prompt(
        intent="explain", policy=Knowledge.EXPLANATORY_BACKGROUND
    )

    # Permitted, and named as concretely as the prohibitions are — an abstract
    # permission weighed against five specific bans produces a terse answer,
    # which is exactly what shipped.
    assert "FIRST, what the meetings establish about it" in brief
    assert "what problem it solves, or what it is organised around" in brief
    assert "who it is for, and what each of those groups is usually there for" in brief
    assert "One abstract sentence is not background" in brief
    # And a named, well-established thing is described rather than dodged.
    assert "describing THAT thing IS" in brief

    # Bounded: every current, event-specific fact, named so there is no
    # ambiguity about which ones are meant.
    for forbidden in (
        "who is speaking", "the dates", "the venue", "the agenda",
        "the ticket tiers", "the prices", "the discounts", "the web address",
        "the attendance", "what is currently available",
    ):
        assert forbidden in brief, forbidden


def test_background_describes_the_category_and_never_this_instance():
    """The Otter-shaped failure, ruled out by name.

    "Tech in Asia Conference 2025 includes VIP passes and pitch stages" is a
    sentence about a real event somebody may be about to buy a ticket to. It is
    not supported by forty-seven seconds of promotional speech and Orion has
    no other source for it.
    """
    brief = answering.system_prompt(
        intent="explain", policy=Knowledge.EXPLANATORY_BACKGROUND
    )

    assert "it is about *specificity*, not topic" in brief
    assert "General background describes the CATEGORY" in brief
    assert "conferences of this kind often include" in brief
    assert "Never write \"the conference includes" in brief
    assert "never assert a fact" in brief.lower()


def test_the_two_permissions_are_not_the_same_permission():
    """A procedure and an explanation license different material.

    Collapsing them into one flag would let "how can I register?" be answered
    with what conferences are for, and "what is this conference?" with the steps
    for buying a ticket. Both are the wrong answer, confidently given.
    """
    procedural = answering.system_prompt(
        intent="how_to", policy=Knowledge.PROCEDURAL_GUIDANCE
    )
    explanatory = answering.system_prompt(
        intent="explain", policy=Knowledge.EXPLANATORY_BACKGROUND
    )

    assert "THEN, general guidance" in procedural
    assert "THEN, general guidance" not in explanatory
    assert "THEN, general background" in explanatory
    assert "THEN, general background" not in procedural


def test_an_explanatory_answer_still_cannot_browse_or_invent():
    brief = answering.system_prompt(
        intent="explain", policy=Knowledge.EXPLANATORY_BACKGROUND
    )

    assert "Every claim about these meetings comes from the passages" in brief
    assert "You cannot look anything up" in brief
    assert "ANSWER FIRST" in brief


def test_a_background_answer_cites_only_what_it_drew_from_the_meeting():
    """The timestamp supports "curated programs and new passes".

    It supports nothing about what conferences of this kind are generally for,
    and an answer whose general half carried a citation would be asserting that
    somebody in the recording said it.
    """
    mixed = Answer(
        text="It is a technology event.\n\n### Generally\nConferences of this kind…",
        used=(1,),
        grounding=answering.MIXED_BACKGROUND,
    )
    extra = TRANSCRIPT + [(1, "Speaker 1: Every role faces its own battle.", 47.0, 60.0, 0.66)]
    service, _ = _service(rows=extra, llm=_Llm(mixed))

    _answer, citations = _ask(service, WHAT_IS)

    assert len(citations) == 1
    assert "curated programs" in citations[0]["text"]


def test_a_background_answer_that_names_nothing_gets_no_citations():
    """Same rule as the procedural kind, and for the same reason."""
    mixed = Answer(text="Conferences of this kind…", used=(),
                   grounding=answering.MIXED_BACKGROUND)
    service, _ = _service(llm=_Llm(mixed))

    _answer, citations = _ask(service, WHAT_IS)

    assert citations == []


def test_thin_evidence_does_not_mean_thin_background():
    """The clause that made the answer terse, ruled out.

    The block used to close "if the meetings say almost nothing about the
    thing, keep the background short". The Tech in Asia recording is
    forty-seven seconds of promotional speech — it says almost nothing — so the
    model produced one abstract sentence of background and stopped.

    That is backwards. The two halves are sized independently: a reader whose
    meeting mentioned something once is *more* likely to be asking what it is,
    not less.
    """
    brief = answering.system_prompt(
        intent="explain", policy=Knowledge.EXPLANATORY_BACKGROUND
    )

    assert "does NOT decide how much background to give" in brief
    assert "explain the thing properly" in brief
    assert "keep the background short" not in brief
    # The bound that replaced it is about substance, not size.
    assert "Stop when you run out of things that are true and useful" in brief


def test_an_explanation_is_not_capped_at_a_lookups_length():
    """Express opened "Be brief. A short paragraph, or up to five bullets."

    That is a length chosen before the question is read, and there is no
    instruction that says both "be brief" and "explain this properly".
    """
    express = answering.system_prompt(
        intent="explain", depth="express", policy=Knowledge.EXPLANATORY_BACKGROUND
    )

    assert "Be brief" not in express
    assert "Be concise but complete" in express
    assert "an explanation that genuinely has parts gets those parts" in express
    # And no floor either: a question with one answer still gets one sentence.
    assert "a question with one answer gets one sentence" in express
    assert "Never pad to look thorough" in express


def test_advanced_goes_further_into_the_thing_itself():
    express = answering.system_prompt(
        intent="explain", depth="express", policy=Knowledge.EXPLANATORY_BACKGROUND
    )
    advanced = answering.system_prompt(
        intent="explain", depth="advanced", policy=Knowledge.EXPLANATORY_BACKGROUND
    )

    assert express != advanced
    assert "how it works, what it relates to, and where it is and is not" in advanced
    assert "Go deeper" in advanced and "Go deeper" not in express
    # Both still grounded about the specific thing.
    for brief in (express, advanced):
        assert "General background describes the CATEGORY" in brief


def test_a_question_about_the_recording_gets_no_background():
    """The half that proves the new policy did not leak into factual answers."""
    for question in ("What did they say about the conference?", "What price did they quote?"):
        capture = _CapturingAdapter()
        service, _ = _service(llm=capture)

        asyncio.run(service.answer("mtg_talk", question, "usr_1", "express"))

        assert "THEN, general background" not in (capture.system or ""), question
        assert "the passages are the only source there is" in (capture.system or ""), question


# --- the strict direction ---------------------------------------------------- #

def test_a_factual_question_gets_no_licence_to_supplement():
    """The test that proves the new policy did not destroy grounding.

    Every one of these is a question about the world that the reader is asking
    of their own meeting. A typical conference ticket price is real knowledge
    and completely useless here: it would be read as the price *this* event
    charges, because that is what was asked.
    """
    for question in FACT_QUESTIONS + ["What price did they quote?"]:
        service, llm = _service()
        _ask(service, question)

        assert llm.kwargs["policy"] is Knowledge.MEETING_ONLY, question
        assert "THEN, general guidance" not in llm.system, question


def test_the_strict_brief_names_the_temptation_and_refuses_it():
    service, llm = _service()

    _ask(service, "What does registration cost?")
    brief = llm.system

    assert "the passages are the only source there is" in brief
    assert "the meeting doesn't state a price" in brief
    assert "Do not offer a typical figure, a usual range, a likely date" in brief
    # Why, spelled out: the reader cannot tell a guess from a quote, and will
    # act on it either way.
    assert "cannot tell you guessed is worse than no number" in brief


def test_how_many_is_a_count_and_not_a_procedure():
    """`how` opens both kinds of question, and the router must not confuse them.

    "How many attendees were mentioned?" is a lookup over the transcript. Giving
    it the procedural brief would permit an answer about how attendance is
    normally estimated, in place of a number the meeting either has or lacks.
    """
    assert questions.classify("How many attendees were mentioned?") == "inventory"
    assert questions.knowledge_policy("inventory") is Knowledge.MEETING_ONLY


def test_how_did_it_change_is_a_sequence_and_not_a_procedure():
    assert questions.classify("How did the pricing decision change over time?") == "timeline"
    assert questions.knowledge_policy("timeline") is Knowledge.MEETING_ONLY


def test_most_questions_get_the_strict_policy():
    """Guidance is the exception. If it stops being one, this fails."""
    permitted = {
        i for i in questions.INTENTS
        if questions.knowledge_policy(i) is not Knowledge.MEETING_ONLY
    }

    assert permitted == {"how_to", "compose", "explain"}


# --- advisory questions: the meeting leads ----------------------------------- #

def test_what_should_i_do_next_is_procedural():
    assert questions.classify("What should I do after this meeting?") == "how_to"


def test_generic_advice_may_never_displace_a_real_commitment():
    """§27's rule, in the brief rather than in a hopeful test of prose.

    Somebody asking what to do after a meeting that produced four action items
    wants those four items. Generic "send a recap, book a follow-up" advice in
    their place is worse than no answer, because it looks like an answer.
    """
    brief = answering.system_prompt(
        intent="how_to", policy=Knowledge.PROCEDURAL_GUIDANCE)

    assert "If the meetings already answer the question in full, stop when they do" in brief
    assert "must never take the place of a real commitment, decision or action item" in brief


def test_the_action_item_ledger_still_reaches_an_advisory_question():
    """The evidence half of the same rule, on the workspace path where the
    tracked items live."""
    service, llm = _service(rows=[])

    async def _ledger(*_a, **_k):
        return ["Tracked items follow:", "[Action item · OPEN · Kickoff] send the pricing deck"]

    async def _none(*_a, **_k):
        return []

    service._commitment_context = _ledger  # type: ignore[assignment]
    service._decision_context = _none  # type: ignore[assignment]

    asyncio.run(service.answer_workspace("usr_1", "What should I do after this meeting?"))

    assert "send the pricing deck" in " ".join(llm.context or [])


# --- citations on a mixed answer --------------------------------------------- #

def test_a_mixed_answer_cites_only_the_passage_its_meeting_claim_came_from():
    """§10. The timestamp proves the transcript said "register now".

    It proves nothing whatever about "complete payment if required", and an
    answer whose general half carries a meeting citation is asserting that
    somebody said it. The model names the passages behind the grounded half;
    the general half names none, and so contributes none.
    """
    extra = TRANSCRIPT + [(1, "Speaker 1: Every role faces its own battle.", 47.0, 60.0, 0.66)]
    mixed = Answer(
        text="The transcript has no link.\n\n### General next steps\n1. Find the site.",
        used=(1,),
        grounding=MIXED,
    )
    service, _llm = _service(rows=extra, llm=_Llm(mixed))

    _answer, citations = _ask(service, REGISTER)

    assert len(citations) == 1
    assert "Register now" in citations[0]["text"]


def test_an_answer_that_used_nothing_from_the_meeting_is_still_honest():
    """No citation at all beats one that does not support anything said.

    The fallback when the model names no passages is "everything retained",
    which is what citations were before the contract existed. That is the right
    default for a grounded answer and the wrong one here — so an answer that
    reports itself as mixed and cites nothing gets no sources rather than the
    whole retained set attached to a paragraph of general advice.
    """
    mixed = Answer(text="Generally, you would…", used=(), grounding=MIXED)
    service, _llm = _service(llm=_Llm(mixed))

    _answer, citations = _ask(service, REGISTER)

    assert citations == []


def test_a_meeting_only_answer_that_names_nothing_still_cites_its_evidence():
    """The other side of the same rule, which the fallback exists for.

    An older adapter, or a reply whose `used` failed to parse, must not silently
    lose its sources — every sentence of a meeting-only answer came from the
    passages, so attaching them is a true claim.
    """
    service, _llm = _service(llm=_Llm(Answer(text="They said to register.", used=())))

    _answer, citations = _ask(service, REGISTER)

    assert len(citations) == 1


# --- the label ---------------------------------------------------------------- #

def test_the_grounding_label_never_reaches_the_reader():
    brief = answering.system_prompt(
        intent="how_to", policy=Knowledge.PROCEDURAL_GUIDANCE)

    assert "Never mention it, or these labels, in the answer itself" in brief


def test_an_answer_that_does_not_declare_itself_is_read_strictly():
    """Silence is not permission.

    A reply with no `grounding` field, or an unrecognised one, is treated as a
    claim about the meetings — which is the reading that binds it to every rule
    rather than the one that excuses it from them.
    """
    assert answering.parse({"answer": "x"}, 1).grounding == MEETING_ONLY
    assert answering.parse({"answer": "x", "grounding": "anything"}, 1).grounding == MEETING_ONLY
    assert answering.parse({"answer": "x", "grounding": MIXED}, 1).mixed is True


def test_the_policy_is_observable_without_reading_a_transcript():
    """§35. What was asked, what was allowed, what came back — no content.

    These lines land in log aggregators. The intent and the two policy labels
    are enough to find a question that was classified wrongly; the question
    itself, and every word of the meeting, stay out.
    """
    from app.retrieval import RetrievalReport

    line = RetrievalReport(
        mode="advanced", intent="how_to",
        policy=Knowledge.PROCEDURAL_GUIDANCE, grounding=MIXED,
    )
    line.kept = 4
    line.used = 1

    data = line.as_dict()

    assert data["intent"] == "how_to"
    assert data["policy"] == "procedural_guidance"
    assert data["grounding"] == MIXED
    assert data["mode"] == "advanced"
    assert all(not isinstance(v, str) or "Register" not in v for v in data.values())


# --- the intent actually reaches the model ------------------------------------ #
#
# Adding `how_to` to the classifier and forgetting to hand it to the adapter
# would leave every symptom identical: the same unhelpful answer, from a service
# that now classifies the question correctly. So this walks the real chain —
#
#     classify -> RagService.answer -> LlmPort.answer -> OpenAiLlmAdapter
#               -> answering.system_prompt
#
# — with only the network call stubbed. Nothing here rebuilds the prompt itself;
# it reads the one the adapter actually sent.

class _CapturingAdapter:
    """The real adapter, with only its HTTP call replaced.

    Subclassing rather than faking, so `answer()` — the method that decides
    which brief to build — is the shipped one.
    """

    def __init__(self):
        from app.providers.openai_adapter import OpenAiLlmAdapter

        self.system: str | None = None
        self.user: str | None = None

        adapter = OpenAiLlmAdapter.__new__(OpenAiLlmAdapter)
        adapter._settings = rag_settings()  # type: ignore[attr-defined]

        async def _chat_json(system, user, *, model=None):
            self.system, self.user = system, user
            return {"answer": "…", "used": [1], "grounding": MIXED}

        adapter._chat_json = _chat_json  # type: ignore[assignment]
        self.adapter = adapter

    async def answer(self, *a, **kw):
        return await self.adapter.answer(*a, **kw)


def test_the_how_to_intent_reaches_the_real_adapters_prompt():
    capture = _CapturingAdapter()
    service, _ = _service(llm=capture)

    asyncio.run(service.answer("mtg_talk", REGISTER, "usr_1", "express"))

    assert capture.system is not None, "the adapter was never called"
    # The procedural half of the brief, in the prompt the adapter built.
    assert "This question asks how to *do* something" in capture.system
    assert "THEN, general guidance" in capture.system
    assert "This asks how to proceed" in capture.system
    # And the evidence went with it.
    assert "Register now" in (capture.user or "")


def test_a_factual_question_reaches_that_same_adapter_with_the_strict_brief():
    """The other side of the same propagation, or the test above proves only
    that *some* brief arrives."""
    capture = _CapturingAdapter()
    service, _ = _service(llm=capture)

    asyncio.run(service.answer("mtg_talk", "When is the conference?", "usr_1", "express"))

    assert "the passages are the only source there is" in (capture.system or "")
    assert "THEN, general guidance" not in (capture.system or "")


def test_both_answer_paths_classify_and_pass_the_intent():
    """`answer` and `answer_workspace` are separate code paths and each has to
    do this itself. One of them quietly not classifying is invisible."""
    # The two queries return differently shaped rows — the workspace one carries
    # the meeting id, title and date the single-meeting one has no need of — so
    # each path is given its own.
    workspace_rows = [(0, SPEECH, 0.0, 47.0, "mtg_talk", "Tech in Asia", None, 0.61)]
    paths = [
        (TRANSCRIPT, lambda svc: svc.answer("mtg_talk", REGISTER, "usr_1", "express")),
        (workspace_rows, lambda svc: svc.answer_workspace("usr_1", REGISTER, mode="express")),
    ]

    for rows, run in paths:
        capture = _CapturingAdapter()
        service, _ = _service(rows=rows, llm=capture)

        async def _none(*_a, **_k):
            return []

        service._commitment_context = _none  # type: ignore[assignment]
        service._decision_context = _none  # type: ignore[assignment]
        service._meetings_named_in = _none  # type: ignore[assignment]

        asyncio.run(run(service))

        assert "THEN, general guidance" in (capture.system or ""), run


# --- general guidance is not evidence ---------------------------------------- #

def test_guidance_is_never_written_back_as_something_somebody_said():
    """§11, asserted where it is actually enforced: the indexer.

    Only a transcript is ever indexed into pgvector, and the one path that
    writes there takes a meeting id and a transcript. There is no route by which
    an answer — general half or grounded half — becomes a chunk, an action item
    or a decision, and therefore none by which today's advice becomes tomorrow's
    evidence.
    """
    import inspect

    from app.rag import RagService as Real

    writers = [
        name
        for name, fn in inspect.getmembers(Real, inspect.isfunction)
        if "INSERT INTO transcript_chunks" in (inspect.getsource(fn) or "")
    ]

    assert writers == ["index"]
    assert "transcript" in inspect.signature(Real.index).parameters


def test_a_previous_answer_is_never_handed_back_as_evidence():
    """§34. History carries the user's questions and nothing else.

    "Did the speaker mention a price?" asked after a procedural answer must be
    answered from the transcript. If the previous answer travelled with it, the
    general registration steps would be sitting in the prompt as material — and
    the follow-up would be grounded in Orion's own advice.
    """
    prompt = answering.user_prompt(
        "Did the speaker mention a price?",
        [SPEECH],
        ["How can I register?"],
    )

    assert "How can I register?" in prompt
    assert "They are not evidence" in prompt
    # The shape of the guarantee: `user_prompt` has no parameter that could
    # carry an answer, so there is nothing for a future caller to pass.
    import inspect

    assert set(inspect.signature(answering.user_prompt).parameters) == {
        "question", "passages", "history",
    }
