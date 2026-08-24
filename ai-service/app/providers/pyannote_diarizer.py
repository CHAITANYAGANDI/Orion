"""pyannote.audio behind DiarizationPort.

<h2>Why this model</h2>

Community-1 is a full segmentation-and-clustering pipeline rather than a
speaker-verification embedder pressed into service as one. That difference is
the whole point of the rewrite: it decides boundaries from the audio directly,
so a one-word "Exactly." can get its own turn without anybody having to build a
usable embedding out of 400 milliseconds. It reads the whole recording, so the
same voice keeps the same cluster from minute one to minute forty. And it can
find a speaker the transcription provider missed entirely, which the previous
repair was structurally incapable of.

It is MIT-licensed, which matters: the ungated alternative
(``nvidia/diar_sortformer_4spk-v1``) is CC-BY-NC and cannot ship in a commercial
product, and pyannote's own Precision-2 is a paid API. Those were checked before
this was written rather than after.

<h2>exclusive_speaker_diarization</h2>

Recallix stores one speaker per word and has nowhere to put two. Asked for its
exclusive output, the pipeline returns a partition of time with overlaps already
resolved — which is exactly the shape the reconciler wants, produced by the
model that heard the overlap rather than by a tie-break rule downstream. Where
the attribute is absent we fall back to the ordinary annotation and let
``Timeline.normalised`` resolve it, recording how much was removed.

<h2>The gate</h2>

The weights are gated on Hugging Face: unauthenticated requests get HTTP 401.
A deployment must accept the model's terms once and supply a read token as
``HF_TOKEN``. Without it this port reports itself unavailable and the pipeline
keeps the provider's labels — a meeting still processes, it simply does not get
the repair. That is deliberate: a missing credential must not fail a transcript.
"""

from __future__ import annotations

import array
import logging
import os
import subprocess
from pathlib import Path

from app.diarize_port import SpeakerTurn, Timeline, unavailable

logger = logging.getLogger("ai-service.diarize.pyannote")

#: The pipeline this port is written against.
MODEL = "pyannote/speaker-diarization-community-1"

#: Where the weights are baked at image build time, so a container start does
#: not depend on Hugging Face being reachable.
DEFAULT_CACHE = "/opt/models/pyannote"

_pipeline = None
_load_error: str | None = None


def _token() -> str | None:
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return None


#: Everything is resampled to this. pyannote's own models are trained at
#: 16 kHz, and it is what the existing embedder already asks ffmpeg for.
SAMPLE_RATE = 16_000


def _decode(audio: bytes):
    """Whatever arrived, as a mono float32 waveform in memory.

    In memory rather than a temporary file for two reasons. A recording is a
    user's, and the fewer places it is written the fewer places it can be left
    behind. And pyannote's own file reader needs torchcodec, whose shared
    object does not load on this image — passing a waveform bypasses it
    entirely, so the port does not depend on a decoder it does not use.

    Raw PCM out of ffmpeg rather than a wav container: there is no header to
    parse and no ambiguity about sample width.
    """
    import torch

    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1"],
        input=audio, check=True, capture_output=True,
    ).stdout
    samples = array.array("h")
    samples.frombytes(raw)
    waveform = torch.tensor(samples, dtype=torch.float32).unsqueeze(0) / 32768.0
    return {"waveform": waveform, "sample_rate": SAMPLE_RATE}


class PyannoteDiarizer:
    """audio → speaker timeline, and nothing else."""

    def __init__(self, *, model: str = MODEL, cache_dir: str | None = None) -> None:
        self._model = model
        self._cache = cache_dir or os.environ.get("PYANNOTE_CACHE") or DEFAULT_CACHE

    @property
    def name(self) -> str:
        return self._model

    def unavailable_reason(self) -> str | None:
        """Why this cannot run, or None. Safe to call before any audio exists."""
        try:
            import pyannote.audio  # noqa: F401
        except ImportError:
            return "pyannote.audio is not installed"
        if not _token() and not Path(self._cache).exists():
            return "no HF_TOKEN and no cached weights"
        return None

    def available(self) -> bool:
        return self.unavailable_reason() is None

    def _load(self):
        """The pipeline, loaded once per process.

        Module-level rather than per instance because the weights are hundreds
        of megabytes and a second copy buys nothing. A failure is remembered too:
        retrying a broken load on every meeting turns one misconfiguration into
        a per-meeting stall.
        """
        global _pipeline, _load_error
        if _pipeline is not None or _load_error is not None:
            return _pipeline

        try:
            import torch
            from pyannote.audio import Pipeline

            _pipeline = Pipeline.from_pretrained(
                self._model,
                token=_token(),
                cache_dir=self._cache,
            )
            # CPU on purpose. The image has no CUDA, and diarization of a
            # meeting-length recording is comfortably within a worker's budget
            # on CPU; see the runtime note in docs/diarization.md.
            _pipeline.to(torch.device("cpu"))
            logger.info("pyannote pipeline ready (%s).", self._model)
        except Exception as exc:  # noqa: BLE001 - any failure means "unavailable"
            _load_error = f"{type(exc).__name__}: {exc}"
            logger.warning("pyannote unavailable: %s", _load_error)
        return _pipeline

    async def diarize(self, audio: bytes) -> Timeline:
        """Read the whole recording and return who spoke when.

        Never raises for ordinary failure. A meeting with a good transcript and
        a broken diarizer keeps its transcript.
        """
        reason = self.unavailable_reason()
        if reason:
            return unavailable(reason, self._model)
        if not audio:
            return unavailable("no audio", self._model)

        pipeline = self._load()
        if pipeline is None:
            return unavailable(_load_error or "pipeline failed to load", self._model)

        try:
            output = pipeline(_decode(audio))
        except Exception as exc:  # noqa: BLE001
            logger.warning("pyannote failed on this recording: %s", exc)
            return unavailable(f"{type(exc).__name__}", self._model)

        return _to_timeline(output, self._model)


def _to_timeline(output, model: str) -> Timeline:
    """pyannote's annotation → our Timeline.

    pyannote 4 returns a ``DiarizeOutput`` carrying several views of the same
    result; 3.x returned the annotation itself. Both are accepted, because the
    installed version is a deployment decision and this port should not be the
    thing that breaks on an upgrade.

    Prefers ``exclusive_speaker_diarization`` where the build provides it: that
    is the model's own resolution of overlapping speech, and Recallix has one
    speaker field per word, so somebody has to resolve it. Better the model that
    heard the audio than a rule applied afterwards.
    """
    plain = getattr(output, "speaker_diarization", output)
    exclusive = getattr(output, "exclusive_speaker_diarization", None)
    annotation = exclusive if exclusive is not None else plain
    overlap = 0.0

    if exclusive is not None:
        # How much simultaneous speech the model resolved away, so the honest
        # figure survives into the limitation note rather than vanishing.
        overlap = max(0.0, _total(plain) - _total(exclusive))

    turns = [
        SpeakerTurn(start=float(segment.start), end=float(segment.end), speaker=str(label))
        for segment, _, label in annotation.itertracks(yield_label=True)
    ]
    return Timeline(turns=turns, model=model, overlap_seconds=overlap).normalised()


def _total(annotation) -> float:
    return sum(
        float(segment.end) - float(segment.start)
        for segment, _, _ in annotation.itertracks(yield_label=True)
    )
