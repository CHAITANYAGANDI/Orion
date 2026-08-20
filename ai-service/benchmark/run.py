"""Run one audio file through Recallix transcription and score the result.

    python -m benchmark.run ../benchmark-audio/transcription-test.mp3 \
        --reference ../benchmark-audio/otter-reference.txt

Prints a scorecard and, with `--json`, a machine-readable one for tracking over
time. Nothing is committed: `benchmark-audio/` is gitignored because the audio
is third-party material and the reference transcripts derive from it.

## The comparison has to be fair, and the obvious one is not

Do **not** compare a room played through speakers into a laptop microphone
against a file uploaded directly to another product. That was the shape of the
original complaint about Recallix's transcription quality and it measures
mostly the microphone: two different signals, two different processing modes,
and the gap between them is not the thing anybody wanted to know about.

The comparison this runs is the fair one — the *same file*, through Recallix's
final asynchronous path, against a human or reference transcript of that file.

## Latency is measured, not assumed

`processing_seconds` is wall-clock for the whole job including the upload, and
`realtime_factor` divides it by the audio duration. A factor of 0.2 means a
one-hour meeting takes twelve minutes, which is the number to quote when
somebody asks how long processing takes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys
import time

from app.config import Settings
from app.providers.assemblyai_adapter import TranscriptionRequest
from app.providers.factory import AiProviderFactory
from app.schemas import MeetingContext as MeetingContextSchema
from app.schemas import SpeakerExpectation
from benchmark.metrics import Turn, score
from benchmark.reference import parse


def _turns_from(segments) -> list[Turn]:
    return [
        Turn(speaker=s.speaker, text=s.text, start=s.start)
        for s in segments
        if s.text.strip()
    ]


async def transcribe(path: pathlib.Path, args) -> tuple[list[Turn], float, object]:
    settings = Settings()
    adapter = AiProviderFactory.create_transcription(settings)

    speakers = SpeakerExpectation()
    if args.speakers_exact:
        speakers = SpeakerExpectation(mode="exact", exact=args.speakers_exact)
    elif args.speakers_min or args.speakers_max:
        speakers = SpeakerExpectation(
            mode="range", minimum=args.speakers_min, maximum=args.speakers_max
        )

    request = TranscriptionRequest.from_event(
        language=args.language,
        vocabulary=args.keyterm,
        context=MeetingContextSchema(
            title=args.title,
            project=args.project,
            meeting_type=args.meeting_type,
            participants=args.participant,
            organisations=[],
        ),
        speakers=speakers,
    )

    started = time.perf_counter()
    result = await adapter.transcribe(path.read_bytes(), path.name, request=request)
    elapsed = time.perf_counter() - started
    return _turns_from(result.segments), elapsed, result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=pathlib.Path)
    parser.add_argument("--reference", type=pathlib.Path,
                        help="Ground-truth transcript. Without one, the "
                             "transcript is printed and nothing is scored.")
    parser.add_argument("--language", default=None)
    parser.add_argument("--title", default=None)
    parser.add_argument("--project", default=None)
    parser.add_argument("--meeting-type", default=None)
    parser.add_argument("--participant", action="append", default=[],
                        help="Repeatable. Used for prompting and keyterms; "
                             "never to infer how many speakers there are.")
    parser.add_argument("--keyterm", action="append", default=[])
    parser.add_argument("--speakers-exact", type=int, default=None)
    parser.add_argument("--speakers-min", type=int, default=None)
    parser.add_argument("--speakers-max", type=int, default=None)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--save", type=pathlib.Path,
                        help="Write the hypothesis transcript here.")
    args = parser.parse_args()

    if not args.audio.exists():
        print(f"No such file: {args.audio}", file=sys.stderr)
        print("Benchmark audio is deliberately not committed. See "
              "docs/transcription-benchmark.md.", file=sys.stderr)
        return 2

    hypothesis, elapsed, raw = asyncio.run(transcribe(args.audio, args))

    if args.save:
        args.save.write_text(
            "\n".join(f"{t.speaker}: {t.text}" for t in hypothesis), encoding="utf-8"
        )

    if not hypothesis:
        print("Transcription returned nothing. Check ASSEMBLYAI_API_KEY and "
              "TRANSCRIPTION_PROVIDER.", file=sys.stderr)
        return 1

    duration = max((t.start or 0) for t in hypothesis) if hypothesis else 0.0
    report: dict[str, object] = {
        "audio": str(args.audio),
        "processing_seconds": round(elapsed, 1),
        "audio_seconds": round(duration, 1),
        "realtime_factor": round(elapsed / duration, 3) if duration else None,
        "hypothesis_turns": len(hypothesis),
        "detected_language": getattr(raw, "language", None),
    }

    if args.reference and args.reference.exists():
        reference = parse(args.reference.read_text(encoding="utf-8"))
        card = score(reference, hypothesis)
        report.update(card.as_row())
        report["speaker_mapping"] = card.speaker_mapping
    elif args.reference:
        print(f"No reference at {args.reference}; scoring skipped.", file=sys.stderr)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        width = max(len(k) for k in report)
        for key, value in report.items():
            print(f"{key.rjust(width)} : {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
