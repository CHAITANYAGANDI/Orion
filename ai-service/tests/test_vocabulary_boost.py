"""Custom vocabulary: how a user's terms reach each transcription provider.

The three providers express boosting differently and are not interchangeable —
sending the wrong parameter name is a boost that looks configured and does
nothing, which is the failure mode these tests exist to catch.
"""

from __future__ import annotations

import pytest

from app.providers.deepgram_adapter import MAX_BOOST_TERMS, boost_params
from app.transcription_context import MeetingContext, build_keyterms
from app.providers.openai_adapter import prompt_hint


# --- Deepgram --------------------------------------------------------------- #
def test_no_vocabulary_sends_no_boosting_parameter():
    # Not `{"keyterm": []}`: an empty parameter is still a parameter, and
    # Deepgram rejects some empty values rather than ignoring them.
    assert boost_params(None, "nova-3") == {}
    assert boost_params([], "nova-3") == {}


def test_nova_3_uses_keyterm():
    assert boost_params(["Kubernetes"], "nova-3") == {"keyterm": ["Kubernetes"]}


def test_nova_2_uses_the_legacy_keywords_parameter():
    # nova-2 silently ignores `keyterm`, so the older name is not optional here.
    assert boost_params(["Kubernetes"], "nova-2") == {"keywords": ["Kubernetes"]}


def test_an_unknown_model_defaults_to_the_current_parameter():
    assert "keyterm" in boost_params(["Kubernetes"], "nova-4-whatever")


def test_terms_are_deduplicated_case_insensitively():
    # Two rows differing only in case would otherwise weight the term twice.
    result = boost_params(["Recallix", "recallix", "RECALLIX"], "nova-3")
    assert result == {"keyterm": ["Recallix"]}


def test_commas_are_stripped_because_deepgram_splits_on_them():
    # "Smith, Jane" would arrive as two partial terms and boost neither.
    assert boost_params(["Smith, Jane"], "nova-3") == {"keyterm": ["Smith Jane"]}


def test_blank_terms_are_dropped():
    assert boost_params(["  ", "", "Recallix"], "nova-3") == {"keyterm": ["Recallix"]}


def test_the_list_is_capped():
    terms = [f"term{i}" for i in range(MAX_BOOST_TERMS + 25)]
    assert len(boost_params(terms, "nova-3")["keyterm"]) == MAX_BOOST_TERMS


# --- AssemblyAI ------------------------------------------------------------- #
#
# `word_boost` is gone as a public function. AssemblyAI's Universal-3 family
# takes `keyterms_prompt` instead, built by app.transcription_context from the
# vocabulary *and* everything else Recallix knows about the meeting; the
# adapter still falls back to word_boost when universal-2 is the only model in
# play, which is covered in tests/test_assemblyai.py against the request body.
def test_assemblyai_keyterms_are_empty_without_vocabulary():
    assert build_keyterms(MeetingContext(), None) == []
    assert build_keyterms(MeetingContext(), []) == []


def test_assemblyai_deduplicates_and_preserves_order():
    assert build_keyterms(MeetingContext(), ["SRE", "sre", "Kubernetes"]) == [
        "SRE", "Kubernetes"
    ]


# --- OpenAI / Whisper ------------------------------------------------------- #
def test_whisper_prompt_is_empty_without_vocabulary():
    # An empty prompt would still be sent and would waste tokens biasing nothing.
    assert prompt_hint(None) == ""
    assert prompt_hint([]) == ""


def test_whisper_prompt_lists_the_terms():
    hint = prompt_hint(["Kubernetes", "SRE"])
    assert "Kubernetes" in hint and "SRE" in hint


def test_whisper_prompt_is_bounded_to_fit_the_token_limit():
    # Whisper truncates past 224 tokens without saying so, so the list is capped
    # rather than allowed to run off the end.
    hint = prompt_hint([f"term{i}" for i in range(500)], limit=10)
    assert hint.count(",") == 9


@pytest.mark.parametrize("model", ["nova-3", "nova-2"])
def test_every_model_path_drops_empty_input_identically(model):
    assert boost_params([""], model) == {}
