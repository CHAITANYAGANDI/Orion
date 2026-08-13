"""Verify the model's quotations against the transcript, and timestamp them.

A quotation is the one part of a summary that claims to be *exact*. Everything
else in a brief is understood to be a paraphrase, and a reader forgives a loose
one; a quotation attributed to a named person and reproduced in a readout is a
claim that these were the words. A model that tidies grammar, merges two
sentences, or reconstructs a line from memory produces something that reads as
evidence and is not — which is worse than omitting the section, because the
error is invisible and gets forwarded.

So nothing the model returns is trusted. Each candidate is matched back against
the transcript, and only lines that actually appear survive. Matching is
normalised (case, whitespace, the punctuation models routinely change) but not
fuzzy: a paraphrase must fail, or the check is theatre. What survives gets its
speaker and timestamp from the segment it was found in — never from the model —
so the quote is clickable to the moment it was said.
"""

from __future__ import annotations

import logging
import re
import unicodedata

logger = logging.getLogger("ai-service.quotes")

# Models routinely swap straight quotes for curly ones, "..." for an ellipsis
# character, and hyphens for dashes. None of those change the words, so they are
# normalised away rather than treated as a mismatch.
_PUNCT_EQUIVALENTS = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"',
    "–": "-", "—": "-", "−": "-",
    "…": "...",
    " ": " ",
}

# Punctuation that carries no words. Dropped from both sides before comparing,
# so a model adding a full stop or trimming a trailing comma still matches.
_STRIP = re.compile(r"[^\w\s]", re.UNICODE)
_SPACE = re.compile(r"\s+")

# A quote shorter than this is not evidence of anything — "Yes", "Exactly" and
# "I agree" appear in every meeting and would match somewhere by accident.
_MIN_WORDS = 4


def normalise(text: str) -> str:
    """Casefold, canonicalise punctuation, drop it, collapse whitespace.

    Deliberately lossy in exactly the ways that do not change which words were
    said, and in no other way.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    for source, target in _PUNCT_EQUIVALENTS.items():
        text = text.replace(source, target)
    text = _STRIP.sub(" ", text)
    return _SPACE.sub(" ", text).strip().casefold()


def _clean_candidate(raw: str) -> str:
    """Strip the wrapping a model adds around a quote it was told not to wrap.

    Leading/trailing quote marks, and a trailing "— Speaker 2" attribution, are
    presentation rather than words. Removing them here means an otherwise
    genuine quote is not discarded over formatting.
    """
    text = raw.strip()
    # Trailing attribution: "... launch" - Speaker 2  /  "... launch" (Speaker 2)
    text = re.sub(r"\s*[—–-]\s*[^—–-]{0,40}$", "", text)
    text = re.sub(r"\s*\([^()]{0,40}\)\s*$", "", text)
    return text.strip().strip('"“”‘’\'')


def verify_quotes(candidates: list[str], segments: list) -> list[dict]:
    """Keep only the candidates that really appear in `segments`.

    Returns dicts of {text, speaker, start} — `text` being the transcript's
    wording, not the model's, so what is displayed is what was said even when
    the model's copy differed by punctuation.

    Order follows the recording rather than the model's ranking: a reader
    scanning quotes alongside the outline expects them in the order they were
    spoken.
    """
    if not candidates or not segments:
        return []

    # Prepared once: this runs over every candidate.
    haystack = [(normalise(getattr(s, "text", "") or ""), s) for s in segments]

    verified: list[dict] = []
    seen: set[str] = set()

    for raw in candidates:
        candidate = _clean_candidate(raw or "")
        needle = normalise(candidate)
        if not needle or len(needle.split()) < _MIN_WORDS:
            continue

        for text, segment in haystack:
            if not text or needle not in text:
                continue
            key = f"{getattr(segment, 'start', 0)}:{needle}"
            if key in seen:
                break
            seen.add(key)
            verified.append(
                {
                    # The transcript's own wording. The model's copy may differ
                    # in punctuation, and the transcript is the record.
                    "text": _extract_span(getattr(segment, "text", "") or "", candidate),
                    "speaker": getattr(segment, "speaker", "") or "",
                    "start": float(getattr(segment, "start", 0.0) or 0.0),
                }
            )
            break

    dropped = len(candidates) - len(verified)
    if dropped > 0:
        # Worth a log line: a model that suddenly cannot produce a verifiable
        # quote is a signal about the model, not about the meeting.
        logger.info(
            "Dropped %d of %d quotations that do not appear in the transcript.",
            dropped,
            len(candidates),
        )

    verified.sort(key=lambda q: q["start"])
    return verified


def _extract_span(segment_text: str, candidate: str) -> str:
    """The candidate as the transcript words it, falling back to the whole line.

    Word-boundary aligned so the quote never begins or ends mid-word, which is
    what naive index arithmetic on the normalised string would produce.
    """
    words = segment_text.split()
    target = normalise(candidate)
    if not target:
        return segment_text.strip()

    target_length = len(target.split())
    for start in range(0, max(1, len(words) - target_length + 1)):
        for end in range(start + target_length, min(len(words), start + target_length + 3) + 1):
            span = " ".join(words[start:end])
            if normalise(span) == target:
                return span
    return segment_text.strip()
