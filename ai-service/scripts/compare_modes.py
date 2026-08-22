"""Run one question through Express and Advanced, and print what differed.

    docker compose exec ai-service python scripts/compare_modes.py \
        --user usr_abc "What were the key product features highlighted?"

Exists because "Express and Advanced are different" is the sort of claim that
survives long after it stops being true. Both call the same function with the
same arguments but one string changed, and if that string stops reaching the
query — or reaches it and changes nothing that matters — every visible symptom
is identical: two answers, both grounded, both plausible, one of which the user
paid more for.

What it prints is deliberately narrow:

    intent / policy       how the question was routed, and what it may draw on
    grounding             whether the answer stayed inside the passages
    passages considered   what the ANN scan returned before filtering
    passages kept         what survived relevance, dedupe and diversity
    passages used         what the model said it actually drew on
    meetings represented  how many distinct meetings are in the answer
    context characters    what was paid for at the model
    latency               wall clock, retrieval and generation together

No passage text, no meeting titles, no transcript. This is a development tool
that will be run against real accounts, and the numbers are the whole point:
if `considered` moves and `kept` does not, the widening is buying nothing.

Nothing here is reachable from the API. It is a script, run by hand.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import time

from app.config import get_settings
from app.providers.factory import AiProviderFactory
from app.questions import classify, knowledge_policy
from app.rag import RagService
from app.retrieval import RetrievalReport


class _Capture(logging.Handler):
    """Catches the report the service logs at debug level rather than
    re-implementing the pipeline, which would let this drift from the thing it
    is here to measure."""

    def __init__(self) -> None:
        super().__init__()
        self.last: dict | None = None

    def emit(self, record: logging.LogRecord) -> None:
        if record.msg == "retrieval %s" and record.args:
            arg = record.args[0] if isinstance(record.args, tuple) else record.args
            if isinstance(arg, dict):
                self.last = arg


async def run(user_id: str, question: str, meeting_id: str | None) -> None:
    settings = get_settings()
    rag = RagService(
        settings,
        AiProviderFactory.create_embedding(settings),
        AiProviderFactory.create_llm(settings),
    )
    await rag.start()
    if not rag.enabled:
        print("RAG is not configured (PG_HOST unset); nothing to compare.")
        return

    capture = _Capture()
    logger = logging.getLogger("ai-service.rag")
    logger.addHandler(capture)
    logger.setLevel(logging.DEBUG)

    intent = classify(question)
    print(f"question: {question}")
    print(f"intent:   {intent}   (routes retrieval and answer shape)")
    print(f"policy:   {knowledge_policy(intent).value}   "
          "(where this answer may get its material)")

    for mode in ("express", "advanced"):
        capture.last = None
        started = time.perf_counter()
        if meeting_id:
            answer, citations = await rag.answer(meeting_id, question, user_id, mode)
        else:
            answer, citations = await rag.answer_workspace(user_id, question, mode=mode)
        elapsed = time.perf_counter() - started

        report = capture.last or RetrievalReport().as_dict()
        print(f"\n{mode.upper()}\n{'-' * len(mode)}")
        print(f"  grounding reported   : {report.get('grounding')}")
        print(f"  passages considered  : {report.get('considered')}")
        print(f"  passages kept        : {report.get('kept')}")
        print(f"  passages used        : {report.get('used')}")
        print(f"  meetings represented : {report.get('meetings')}")
        print(f"  dropped: unrelated={report.get('droppedUnrelated')} "
              f"trailing={report.get('droppedTrailing')} "
              f"duplicate={report.get('droppedDuplicate')} "
              f"crowding={report.get('droppedCrowding')}")
        print(f"  distance best/worst  : {report.get('bestDistance')} / "
              f"{report.get('worstKeptDistance')}")
        print(f"  context characters   : {report.get('contextChars')}")
        print(f"  citations returned   : {len(citations)}")
        print(f"  latency              : {elapsed:.2f}s")
        print(f"  answer:\n{_indent(answer)}")

    await rag.stop()


def _indent(text: str, width: int = 4) -> str:
    pad = " " * width
    return "\n".join(pad + line for line in (text or "").splitlines())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("question")
    parser.add_argument("--user", required=True, help="the owner whose meetings to search")
    parser.add_argument(
        "--meeting",
        help="ask one meeting instead of the workspace",
    )
    args = parser.parse_args()
    asyncio.run(run(args.user, args.question, args.meeting))


if __name__ == "__main__":
    main()
