"""Language-aware prompting.

A brief about a Spanish meeting has to be written in Spanish — an English
summary of a Spanish conversation is useless to the people who were in the
room. The instruction that makes that happen lives in the OpenAI adapter, which
never runs in tests, so it had no coverage at all until these were written.

The carve-out is the important part: `sourceSentence` is a verbatim quote shown
to the user and matched against by Meeting Memory. Translating it would make it
neither verbatim nor matchable.
"""

from __future__ import annotations

import pytest

from app.providers.openai_adapter import _language_instruction


def test_english_adds_no_instruction():
    # The base prompts are already English; repeating it only costs tokens.
    assert _language_instruction("en") == ""
    assert _language_instruction("EN") == ""
    assert _language_instruction("en-GB") == ""


def test_missing_language_is_treated_as_english():
    assert _language_instruction(None) == ""
    assert _language_instruction("") == ""
    assert _language_instruction("   ") == ""


@pytest.mark.parametrize("code,name", [
    ("es", "Spanish"),
    ("fr", "French"),
    ("de", "German"),
    ("ja", "Japanese"),
    ("hi", "Hindi"),
    ("ta", "Tamil"),
    ("pt", "Portuguese"),
    ("ar", "Arabic"),
])
def test_known_languages_are_named_not_coded(code, name):
    # Naming the language works markedly better than passing a bare ISO code,
    # which models sometimes misread. Checking the code is *absent* would be a
    # bad assertion — two-letter codes hide inside ordinary words ("ar" in
    # "are", "es" in "notes") — so assert the known-language wording instead.
    instruction = _language_instruction(code)
    assert name in instruction
    assert "ISO code" not in instruction, "should name the language, not fall back"


def test_locale_suffix_is_reduced_to_the_language():
    assert "Spanish" in _language_instruction("es-419")
    assert "Portuguese" in _language_instruction("pt-BR")


def test_unknown_code_still_produces_a_usable_instruction():
    # Better to pass the code through than to silently fall back to English.
    instruction = _language_instruction("zz")
    assert instruction != ""
    assert "zz" in instruction


def test_verbatim_quotes_are_explicitly_exempt():
    """The whole reason this function is not just 'reply in X'."""
    instruction = _language_instruction("es")
    assert "sourceSentence" in instruction
    assert "Do NOT translate" in instruction


def test_instruction_is_appendable_to_an_existing_prompt():
    # It is concatenated onto prompts that already end in a sentence, so it has
    # to begin with a separator rather than run words together.
    instruction = _language_instruction("fr")
    assert instruction.startswith(" ")


def test_case_is_normalised():
    assert _language_instruction("ES") == _language_instruction("es")


@pytest.mark.asyncio
async def test_pipeline_passes_the_detected_language_to_every_llm_call():
    """The plumbing: a detected language must reach both analysis calls."""
    from app.pipeline import Pipeline
    from app.providers.mock_adapter import MockLlmAdapter, MockTranscriptionAdapter
    from app.schemas import TranscriptResponse

    seen: list[str] = []

    class RecordingLlm(MockLlmAdapter):
        async def summarize(self, transcript, language="en", **facts):
            seen.append(("summarize", language))
            return await super().summarize(transcript, language, **facts)

        async def extract_action_items(self, transcript, language="en"):
            seen.append(("actions", language))
            return await super().extract_action_items(transcript, language)

    class SpanishTranscriber(MockTranscriptionAdapter):
        async def transcribe(self, audio, filename, language=None, **_):
            return TranscriptResponse(
                transcript="Acordamos usar S3.", language="es", segments=[]
            )

    pipeline = Pipeline(SpanishTranscriber(), RecordingLlm())
    await pipeline.process("mtg_es", b"", "reunion.mp3")

    assert len(seen) == 2, "both analysis calls must receive the language"
    assert {language for _, language in seen} == {"es"}


@pytest.mark.asyncio
async def test_documents_default_to_english_when_no_language_is_known():
    from app.pipeline import Pipeline
    from app.providers.mock_adapter import MockLlmAdapter, MockTranscriptionAdapter

    seen: list[str] = []

    class RecordingLlm(MockLlmAdapter):
        async def summarize(self, transcript, language="en", **facts):
            seen.append(language)
            return await super().summarize(transcript, language, **facts)

    pipeline = Pipeline(MockTranscriptionAdapter(), RecordingLlm())
    await pipeline.process_document("mtg_doc", "Minutes text.")

    assert seen == ["en"]
