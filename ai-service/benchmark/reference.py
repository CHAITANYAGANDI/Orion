"""Reading a human transcript, in the shapes humans actually export them in.

The point of a benchmark is that somebody can run it against their own audio in
the morning without writing a parser first. So this reads the format Otter
exports, the format Rev exports, and plain speaker-prefixed text — because
those are what a ground-truth transcript arrives as.

Nothing here is Reverie-specific and nothing here is committed with content:
the transcripts these parse are derived from copyrighted recordings, and
benchmark-audio/ is gitignored for that reason.
"""

from __future__ import annotations

import re

from benchmark.metrics import Turn

__all__ = ["parse", "parse_otter", "parse_speaker_prefixed"]

#: "Speaker 1  0:04" or "Chaitanya   1:02:11" on its own line, the words below.
_OTTER_HEADER = re.compile(
    r"^\s*(?P<speaker>[^\t\n]{1,60}?)\s{2,}(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\s*$"
)

#: "Speaker 1: the words", all on one line. What Reverie itself produces.
_PREFIXED = re.compile(r"^\s*(?P<speaker>[^:\n]{1,60}?)\s*:\s*(?P<text>.+)$")

#: Otter stamps its own exports. Not part of the meeting.
_FOOTERS = (
    "transcribed by https://otter.ai",
    "transcribed by otter.ai",
)


def _seconds(stamp: str) -> float:
    parts = [int(p) for p in stamp.split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return parts[0] * 60 + parts[1]


def _is_footer(line: str) -> bool:
    return line.strip().lower() in _FOOTERS


def parse_otter(text: str) -> list[Turn]:
    """Speaker and timestamp on one line, the words on the lines below."""
    turns: list[Turn] = []
    speaker: str | None = None
    start: float | None = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer
        if speaker is not None and buffer:
            body = " ".join(buffer).strip()
            if body:
                turns.append(Turn(speaker=speaker, text=body, start=start))
        buffer = []

    for raw in text.splitlines():
        if _is_footer(raw):
            continue
        header = _OTTER_HEADER.match(raw)
        if header:
            flush()
            speaker = header.group("speaker").strip()
            start = _seconds(header.group("time"))
            continue
        if raw.strip():
            buffer.append(raw.strip())

    flush()
    return turns


def parse_speaker_prefixed(text: str) -> list[Turn]:
    """One turn per line, `Speaker 1: words`.

    Consecutive lines from the same speaker are merged, because whether a
    provider breaks a long turn into two is a segmentation choice and not a
    transcription error — scoring it as one would penalise the provider that
    formats more helpfully.
    """
    turns: list[Turn] = []
    for raw in text.splitlines():
        if _is_footer(raw) or not raw.strip():
            continue
        match = _PREFIXED.match(raw)
        if not match:
            # A line with no speaker belongs to whoever spoke last; a
            # transcript with no speakers at all becomes one unnamed turn.
            if turns:
                turns[-1] = Turn(turns[-1].speaker,
                                 f"{turns[-1].text} {raw.strip()}".strip(),
                                 turns[-1].start)
            else:
                turns.append(Turn(speaker="Speaker 1", text=raw.strip()))
            continue
        speaker = match.group("speaker").strip()
        body = match.group("text").strip()
        if turns and turns[-1].speaker == speaker:
            turns[-1] = Turn(speaker, f"{turns[-1].text} {body}".strip(), turns[-1].start)
        else:
            turns.append(Turn(speaker=speaker, text=body))
    return turns


def parse(text: str) -> list[Turn]:
    """Whichever of the two shapes this is.

    Sniffed rather than configured, because the alternative is a flag that
    somebody gets wrong once and then spends an afternoon on: a transcript
    parsed with the wrong parser does not fail, it produces one enormous turn
    attributed to nobody and a WER of 1.0 that looks like a catastrophic
    regression.
    """
    if any(_OTTER_HEADER.match(line) for line in text.splitlines()):
        return parse_otter(text)
    return parse_speaker_prefixed(text)
