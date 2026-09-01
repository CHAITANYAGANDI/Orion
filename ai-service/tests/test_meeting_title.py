"""The name a recording is given, read off its own transcript.

A browser recording reaches Reverie called ``Recording — 20/08/2026, 05:03:43``,
because at the moment it is saved the date is all anybody knows. That is a fine
placeholder and a poor name: a dozen of them in a list cannot be scanned or told
apart without opening each one.

The summarizer reads the whole transcript anyway, so the title is asked for in
that same call rather than a second one. Two things are tested here.

**The cleaner**, because the title is the one field that goes straight onto a
row people navigate by. Everything it strips is something a model asked for a
short string has actually returned: markdown emphasis, wrapping quotes, an
echoed "Title:" prefix, a trailing full stop, and the polite refusal — "N/A",
"Untitled" — that is a sentence where an empty string was asked for.

**That the request asks for it at all**, and asks for the empty case out loud. A
recording of a silent room reaches this prompt, and a model asked for a title
will always find one; "Team Sync Discussion" over an empty room is worse than
the timestamp it replaced, because the timestamp never claimed a meeting had
happened.
"""

from __future__ import annotations

import pytest

from app.providers.openai_adapter import (
    TITLE_MAX_CHARS,
    TITLE_SPEC,
    _assemble,
    clean_title,
)
from app.templates import resolve


# --- what is not a name ------------------------------------------------------ #
@pytest.mark.parametrize("raw", [
    None,
    "",
    "   ",
    "N/A",
    "n/a",
    "None",
    "Untitled",
    "untitled meeting",
    "No title",
    "Unknown",
    "Recording",
    "Meeting",
    "Meeting.",
])
def test_a_refusal_is_read_as_no_title(raw):
    """Each of these is the model declining, dressed as an answer.

    Letting one through would put "Untitled" on a row in place of a date, which
    is strictly less informative than the placeholder it replaced.
    """
    assert clean_title(raw) is None


# --- what a name is made of -------------------------------------------------- #
@pytest.mark.parametrize("raw,expected", [
    ("  Q4 pricing decision  ", "Q4 pricing decision"),
    ("Q4 Pricing **Decision**", "Q4 Pricing Decision"),
    ('"Acme renewal call"', "Acme renewal call"),
    ("“Acme renewal call”", "Acme renewal call"),
    ("Title: Sprint review", "Sprint review"),
    ("meeting title - Sprint review", "Sprint review"),
    ("## Renewal terms", "Renewal terms"),
    ("Sprint review.", "Sprint review"),
    ("Sprint\n\n  review", "Sprint review"),
])
def test_the_decoration_comes_off(raw, expected):
    assert clean_title(raw) == expected


def test_emphasis_is_stripped_from_the_middle_and_not_only_the_ends():
    # The bug this pins: stripping only the edges of "Q4 Pricing **Decision**"
    # leaves "Q4 Pricing **Decision" — worse than either version.
    assert "*" not in (clean_title("A **bold** name") or "")
    assert clean_title("A **bold** name") == "A bold name"


# --- how long a name may be -------------------------------------------------- #
def test_a_long_title_is_cut_on_a_word():
    raw = "Kubernetes migration planning for the platform team and everyone else involved"
    out = clean_title(raw)
    assert out is not None
    assert len(out) <= TITLE_MAX_CHARS
    # Never half a word: a name ending "involv" reads as a truncation bug.
    assert raw.startswith(out)
    assert not out.endswith(" ")


def test_one_unbroken_token_is_still_capped():
    # `rsplit` returns the whole string when there is no space in it, so the
    # word-cut alone would let a 200-character token straight through.
    out = clean_title("x" * 300)
    assert out is not None and len(out) == TITLE_MAX_CHARS


def test_a_name_inside_the_limit_is_left_exactly_as_it_is():
    assert clean_title("Acme renewal, phase two") == "Acme renewal, phase two"


# --- what the model is asked ------------------------------------------------- #
def test_the_request_asks_for_a_title_and_for_the_empty_case():
    assert '"title"' in TITLE_SPEC
    # The half that stops a silent recording being named. Without it the model
    # invents something plausible, which is the failure that does not look like
    # one.
    assert '""' in TITLE_SPEC
    assert "empty" in TITLE_SPEC
    # Case-insensitively: the assertion is that the rule is stated, not how the
    # sentence it opens happens to be capitalised.
    spec = TITLE_SPEC.casefold()
    for banned in ("no date", "no time", "trailing full stop", "not the word recording"):
        assert banned in spec
    assert str(TITLE_MAX_CHARS) in TITLE_SPEC


# --- and what comes back ----------------------------------------------------- #
def test_the_title_travels_on_the_summary():
    tpl = resolve(None)
    data = {sec.key: "" for sec in tpl.sections}
    data["title"] = "Q4 pricing decision"

    assert _assemble(tpl, data).title == "Q4 pricing decision"


def test_a_reply_with_no_title_key_is_not_an_error():
    # Older models, a template reply that dropped it, a retry that returned
    # only the sections. The notes are the valuable part and still arrive.
    tpl = resolve(None)
    summary = _assemble(tpl, {sec.key: "" for sec in tpl.sections})

    assert summary.title is None
