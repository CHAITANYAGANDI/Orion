"""Translating a list without changing its shape.

The property under test is the length, not the quality of any translation. Every
caller — key points, summary bullets, action items, transcript utterances —
indexes the reply against the list it sent, so a reply one item short does not
degrade gracefully: it slides every line up by one and puts a speaker's words
under somebody else's name. That reads as a quotation from a person who never
said it, which is worse than a paragraph left in English.

So each chunk is validated on its own and falls back to its own source lines.
Partial translation is a real outcome here and a deliberately visible one.
"""

from __future__ import annotations

import pytest

from app.config import Settings
from app.providers.mock_adapter import MockLlmAdapter
from app.providers.openai_adapter import OpenAiLlmAdapter, _chunk_lines

LINES = [
    "Right, shall we start?",
    "I will finish the JWT validation by Friday.",
    "Yeah.",
    "Marcus is drafting the rollout plan this week.",
]


# --------------------------------------------------------------------------- #
# Chunking
# --------------------------------------------------------------------------- #
def test_a_short_list_is_one_request():
    assert _chunk_lines(LINES) == [LINES]


def test_a_long_transcript_is_split_but_never_a_line():
    lines = [f"utterance number {i}" for i in range(500)]

    chunks = _chunk_lines(lines)

    assert len(chunks) > 1
    # Order and content preserved exactly: chunking is a batching detail, and a
    # line that changed on the way in cannot be matched back on the way out.
    assert [line for chunk in chunks for line in chunk] == lines


def test_a_wall_of_text_is_split_by_size_not_only_by_count():
    # Ten lines, far past the character budget. Splitting on the line count
    # alone would send the whole thing in one request and lose it to a context
    # limit — the failure this budget exists to prevent.
    lines = ["word " * 400 for _ in range(10)]

    assert len(_chunk_lines(lines)) > 1


def test_nothing_in_nothing_out():
    assert _chunk_lines([]) == []


# --------------------------------------------------------------------------- #
# The adapter's contract
# --------------------------------------------------------------------------- #
class _FakeChat:
    """Stands in for `_chat_json`, replying however the test asks it to."""

    def __init__(self, reply):
        self.reply = reply
        self.calls = 0

    async def __call__(self, system, user, *, model=None):
        self.calls += 1
        return self.reply(user) if callable(self.reply) else self.reply


def _adapter(reply) -> OpenAiLlmAdapter:
    adapter = OpenAiLlmAdapter.__new__(OpenAiLlmAdapter)
    adapter._settings = Settings(openai_max_retries=0)
    adapter._chat_json = _FakeChat(reply)  # type: ignore[method-assign]
    return adapter


@pytest.mark.asyncio
async def test_a_keyed_reply_is_read_back_in_order():
    adapter = _adapter({"lines": {str(i): f"ES {line}" for i, line in enumerate(LINES)}})

    assert await adapter.translate_lines(LINES, "Spanish") == [f"ES {line}" for line in LINES]


@pytest.mark.asyncio
async def test_a_plain_array_is_accepted_too():
    # Not wrong, only literal — and the length is what the contract is about.
    adapter = _adapter({"lines": [f"ES {line}" for line in LINES]})

    assert await adapter.translate_lines(LINES, "Spanish") == [f"ES {line}" for line in LINES]


@pytest.mark.asyncio
async def test_a_missing_line_keeps_its_own_source_text():
    reply = {"lines": {"0": "ES uno", "1": "ES dos", "3": "ES cuatro"}}
    adapter = _adapter(reply)

    out = await adapter.translate_lines(LINES, "Spanish")

    # The dropped line stays English in place. It does not shift the ones after
    # it, which is the whole reason the reply is keyed rather than positional.
    assert out == ["ES uno", "ES dos", LINES[2], "ES cuatro"]


@pytest.mark.asyncio
async def test_an_array_of_the_wrong_length_is_refused_entirely():
    adapter = _adapter({"lines": ["ES uno", "ES dos"]})

    # Nothing can be aligned, so nothing is claimed to be.
    assert await adapter.translate_lines(LINES, "Spanish") == LINES


@pytest.mark.asyncio
async def test_a_blank_translation_falls_back_rather_than_erasing_a_line():
    adapter = _adapter({"lines": {"0": "", "1": "  ", "2": "ES tres", "3": "ES cuatro"}})

    out = await adapter.translate_lines(LINES, "Spanish")

    assert out[:2] == LINES[:2]


@pytest.mark.asyncio
async def test_a_model_that_answers_with_nonsense_costs_only_the_translation():
    adapter = _adapter("not a dict at all")

    assert await adapter.translate_lines(LINES, "Spanish") == LINES


@pytest.mark.asyncio
async def test_an_empty_list_never_reaches_the_model():
    adapter = _adapter({"lines": {}})

    assert await adapter.translate_lines([], "Spanish") == []
    assert adapter._chat_json.calls == 0


@pytest.mark.asyncio
async def test_one_bad_chunk_does_not_cost_the_rest():
    lines = [f"line {i}" for i in range(80)]  # two chunks at 40 lines each

    def reply(user: str):
        # Every chunk is numbered from zero, so the content is what identifies
        # it. The first chunk is answered properly; the second is answered short.
        if user.splitlines()[0] == "0 line 0":
            count = len(user.splitlines())
            return {"lines": {str(i): f"ES {i}" for i in range(count)}}
        return {"lines": ["nope"]}

    out = await _adapter(reply).translate_lines(lines, "Spanish")

    assert out[0] == "ES 0"
    assert out[-1] == lines[-1]
    assert len(out) == len(lines)


@pytest.mark.asyncio
async def test_the_mock_honours_the_same_contract():
    # Otherwise dev mode hides the alignment bugs it exists to expose.
    out = await MockLlmAdapter().translate_lines(LINES, "Spanish")

    assert len(out) == len(LINES)
    assert out[1].startswith("[Spanish]")
