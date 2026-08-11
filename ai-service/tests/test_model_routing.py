"""Which model handles which call, and how concurrency is bounded.

The summary is what a user reads, so it stays on the strong model. Extraction
is structured JSON against an explicit schema, which the smaller model handles
well — and its far larger tokens-per-minute allowance means the three
extraction passes stop competing with the summary for one budget.

Routing the wrong way is invisible in the output until a bill or a 429 arrives,
so it is pinned here.
"""

from __future__ import annotations

# `_named_entities` is reached through the private name on purpose: it is the
# only pass still routed to the extraction model, and these tests are about
# which model a call lands on rather than about the pass itself.

import asyncio

import pytest

from app.config import Settings
from app.providers.openai_adapter import OpenAiLlmAdapter

TRANSCRIPT = "Speaker 1: We will ship on Friday.\nSpeaker 2: Agreed."


class _Recorder:
    """Captures the `model` of every chat call and returns empty JSON."""

    def __init__(self):
        self.models: list[str] = []
        self.chat = self
        self.completions = self

    async def create(self, **kwargs):
        self.models.append(kwargs["model"])

        class _Msg:
            content = "{}"

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        return _Resp()


def _adapter(recorder, **overrides) -> OpenAiLlmAdapter:
    settings = Settings(
        openai_chat_model="strong-model",
        openai_extraction_model="cheap-model",
        **overrides,
    )
    return OpenAiLlmAdapter(settings, client=recorder)


@pytest.mark.asyncio
async def test_action_items_stay_on_the_strong_model():
    """Naming who took a task on is a judgement the small model declines to
    make — it returns the tasks with every owner null, and an action item
    without an owner is barely worth extracting."""
    rec = _Recorder()
    a = _adapter(rec)
    await a.extract_action_items(TRANSCRIPT)
    assert rec.models == ["strong-model"]


@pytest.mark.asyncio
async def test_summary_uses_the_strong_model_and_its_entity_pass_the_cheap_one():
    rec = _Recorder()
    a = _adapter(rec)
    await a.summarize(TRANSCRIPT)
    # Entities first — mechanical listing, cheap model — then the summary that
    # draws on them, which is the text a user actually reads.
    assert rec.models == ["cheap-model", "strong-model"]


@pytest.mark.asyncio
async def test_pointing_both_settings_at_one_model_puts_everything_back():
    rec = _Recorder()
    settings = Settings(openai_chat_model="only-model", openai_extraction_model="only-model")
    a = OpenAiLlmAdapter(settings, client=rec)
    await a.extract_action_items(TRANSCRIPT)
    await a.summarize(TRANSCRIPT)
    assert set(rec.models) == {"only-model"}


@pytest.mark.asyncio
async def test_each_model_gets_its_own_concurrency_gate():
    """A shared gate would spend the cheap model's headroom throttling it."""
    rec = _Recorder()
    a = _adapter(rec, openai_max_concurrent_calls=2)

    strong = a._gate_for("strong-model")
    cheap = a._gate_for("cheap-model")

    assert strong is not cheap
    assert a._gate_for("strong-model") is strong  # cached, not rebuilt per call


@pytest.mark.asyncio
async def test_the_gate_bounds_calls_in_flight():
    in_flight = 0
    peak = 0

    class _Slow(_Recorder):
        async def create(self, **kwargs):
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.01)
            in_flight -= 1
            return await super().create(**kwargs)

    rec = _Slow()
    a = _adapter(rec, openai_max_concurrent_calls=2)
    await asyncio.gather(*(a._named_entities(TRANSCRIPT, "en") for _ in range(6)))

    assert peak <= 2


@pytest.mark.asyncio
async def test_the_two_models_do_not_share_a_budget():
    """Six cheap calls must not hold up the strong model's single pass."""
    rec = _Recorder()
    a = _adapter(rec, openai_max_concurrent_calls=1)

    await asyncio.gather(
        *(a._named_entities(TRANSCRIPT, "en") for _ in range(3)),
        a.extract_action_items(TRANSCRIPT),
    )
    assert rec.models.count("cheap-model") == 3
    assert rec.models.count("strong-model") == 1


@pytest.mark.asyncio
async def test_a_zero_setting_still_allows_progress():
    """Misconfiguration must not deadlock the pipeline."""
    rec = _Recorder()
    a = _adapter(rec, openai_max_concurrent_calls=0)
    await a._named_entities(TRANSCRIPT, "en")
    assert rec.models == ["cheap-model"]


@pytest.mark.asyncio
async def test_temperature_is_omitted_unless_configured():
    """Current models reject an explicit temperature with a 400, which
    surfaced as an entirely empty brief rather than an error the user saw."""
    sent = {}

    class _Capture(_Recorder):
        async def create(self, **kwargs):
            sent.update(kwargs)
            return await super().create(**kwargs)

    a = _adapter(_Capture())
    await a._named_entities(TRANSCRIPT, "en")
    assert "temperature" not in sent


@pytest.mark.asyncio
async def test_temperature_is_sent_when_explicitly_set():
    sent = {}

    class _Capture(_Recorder):
        async def create(self, **kwargs):
            sent.update(kwargs)
            return await super().create(**kwargs)

    a = _adapter(_Capture(), openai_temperature=0)
    await a._named_entities(TRANSCRIPT, "en")
    assert sent["temperature"] == 0


@pytest.mark.asyncio
async def test_prose_calls_follow_the_same_rule():
    """RAG chat and translation used to build their own call with a
    hard-coded temperature, so a model change broke them silently."""
    sent = {}

    class _Capture(_Recorder):
        async def create(self, **kwargs):
            sent.update(kwargs)
            return await super().create(**kwargs)

    a = _adapter(_Capture())
    await a.answer("who owns it?", ["Speaker 1: Marcus does."])
    assert "temperature" not in sent
    assert sent["model"] == "strong-model"

    await a.translate("hello", "Spanish")
    assert "temperature" not in sent
