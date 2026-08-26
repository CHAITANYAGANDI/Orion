"""Turning a speaker's turns into a vector that can be compared to another day.

Neither transcription provider Recallix uses can do this. AssemblyAI's own
documentation is explicit that it offers no cross-file speaker identification
and that the way to get it is to "use a model like Nvidia Titanet to generate
speaker embeddings from the audio, then match these embeddings against a vector
database of known speakers". Every other provider evaluated was the same: their
labels are cluster ids for one request and carry no meaning into the next one.
So this is the piece Recallix has to own, and this file is it.

## The model

`speechbrain/spkrec-ecapa-voxceleb` — ECAPA-TDNN trained on VoxCeleb, producing
a 192-dimensional embedding per utterance. Chosen over an ONNX export of the
same architecture for one reason: **the front-end travels with the weights.**
A speaker embedding is only as good as the filterbank feeding it, and a mel
front-end that is subtly wrong — off-by-one window, wrong mean normalisation,
wrong scale — does not fail, it produces embeddings that are still 192 numbers
and still compare to each other. That failure looks exactly like the feature
working until somebody is renamed to the wrong person. SpeechBrain ships the
feature extractor with the checkpoint, so the two cannot drift apart.

The cost is honest and large: torch and speechbrain add roughly a gigabyte to
the image. That is the price of the capability, and the alternative was not a
smaller version of the capability but a plausible-looking one.

## Optional by design

Every import that could fail is deferred into `load()`. An installation without
torch runs exactly as it did before — `available()` returns False, speaker
identification reports itself unavailable, and nothing else in the ai-service
notices. What must never happen is a silent substitute: there is no mock
embedder wired into any default path, because a matcher fed pretend vectors
would produce pretend matches, and a wrong name presented confidently is the
one outcome this whole feature is arranged to avoid.

## Privacy

The waveform handed to `embed` is speech. It is held in memory for the length
of one call and never written anywhere. The vector that comes back is not
reversible to audio, but it is derived from a person's voice and is treated as
biometric-adjacent throughout: see `docs/speaker-identification.md` and the
comments on the `speaker_profiles` table. **Nothing in this module logs a
waveform or an embedding**, at any level, and the test suite asserts it.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from typing import Sequence

from app.voiceprints import EMBEDDING_DIM

logger = logging.getLogger("ai-service.voiceprint")

#: ECAPA-TDNN was trained at 16 kHz. Feeding it anything else is not a quality
#: trade-off, it is a different signal — the filterbank centres move.
SAMPLE_RATE = 16_000

#: Turns shorter than this are not used to build a voiceprint. At the boundary
#: between two people a short turn is mostly the tail of the previous speaker's
#: word, and a one-word interjection carries almost no speaker information but
#: pulls the average toward the middle of the space.
MIN_SPAN_SECONDS = 0.8

#: Ceiling on how much of one speaker goes into one embedding. Beyond roughly
#: this much speech the embedding stops improving, and an hour-long monologue
#: would otherwise cost a minute of CPU to say the same thing.
MAX_SPAN_SECONDS = 45.0

#: The model is baked into the image at build time and read from here. Set to
#: a writable path to let SpeechBrain fetch it at first use instead.
DEFAULT_MODEL_DIR = "/opt/models/ecapa"
DEFAULT_MODEL_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"


class SpeakerEmbeddingUnavailable(RuntimeError):
    """The model is not installed, or could not be loaded.

    Raised rather than returning an empty vector so that callers cannot mistake
    "no model" for "no match" — the first is a deployment fact worth reporting
    to the user, the second is a decision about their data.
    """


@dataclass
class _Spans:
    """Turn boundaries in seconds, already filtered and capped."""

    spans: list[tuple[float, float]]
    seconds: float


def decode_to_pcm(audio: bytes, *, timeout: float = 120.0) -> "object":
    """Decode any container Recallix accepts into 16 kHz mono float32.

    Through ffmpeg rather than a Python decoder because the input is whatever a
    browser produced — webm/opus from MediaRecorder, m4a from a phone, mp3 from
    a dictaphone — and ffmpeg is the only thing that reads all of them without
    a per-format branch. It is invoked on stdin/stdout, so nothing is written to
    disk: the audio exists only in this process's memory.

    Returns a numpy float32 array in [-1, 1].
    """
    import numpy as np

    if not audio:
        return np.zeros(0, dtype="float32")

    try:
        completed = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", "pipe:0",
                "-f", "s16le", "-acodec", "pcm_s16le",
                "-ac", "1", "-ar", str(SAMPLE_RATE),
                "pipe:1",
            ],
            input=audio,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:  # pragma: no cover - deployment fault
        raise SpeakerEmbeddingUnavailable("ffmpeg is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise SpeakerEmbeddingUnavailable("decoding the recording timed out") from exc

    if completed.returncode != 0 or not completed.stdout:
        # stderr can name the file; the message is kept generic on purpose.
        raise SpeakerEmbeddingUnavailable("the recording could not be decoded")

    pcm = np.frombuffer(completed.stdout, dtype="<i2").astype("float32")
    return pcm / 32768.0


def choose_spans(
    spans: Sequence[tuple[float, float]],
    *,
    min_span: float = MIN_SPAN_SECONDS,
    max_total: float = MAX_SPAN_SECONDS,
) -> _Spans:
    """Pick which of a speaker's turns go into their voiceprint.

    Longest first, then re-sorted chronologically. Two reasons, both about what
    a short turn actually contains: it is disproportionately likely to be a
    misattributed handover, and even when correct it carries little speaker
    information. Taking the first N seconds instead would over-weight whatever
    happened at the top of the meeting, which is often somebody reading an
    agenda in a different register from the rest of their contribution.
    """
    usable = [
        (float(start), float(end))
        for start, end in spans
        if end is not None and start is not None and (float(end) - float(start)) >= min_span
    ]
    usable.sort(key=lambda s: s[1] - s[0], reverse=True)

    taken: list[tuple[float, float]] = []
    total = 0.0
    for start, end in usable:
        if total >= max_total:
            break
        length = end - start
        if total + length > max_total:
            end = start + (max_total - total)
            length = end - start
        taken.append((start, end))
        total += length

    taken.sort(key=lambda s: s[0])
    return _Spans(spans=taken, seconds=total)


def take_spans(pcm: "object", spans: Sequence[tuple[float, float]]) -> "object":
    """Concatenate the samples inside those time ranges."""
    import numpy as np

    if len(pcm) == 0 or not spans:
        return np.zeros(0, dtype="float32")
    pieces = []
    for start, end in spans:
        lo = max(0, int(start * SAMPLE_RATE))
        hi = min(len(pcm), int(end * SAMPLE_RATE))
        if hi > lo:
            pieces.append(pcm[lo:hi])
    if not pieces:
        return np.zeros(0, dtype="float32")
    return np.concatenate(pieces)


class EcapaEmbedder:
    """ECAPA-TDNN speaker embeddings, loaded once and reused.

    Loading costs a few seconds and around 80 MB of resident memory, so the
    model is held for the process lifetime. `load()` is idempotent and is called
    lazily: an ai-service that never identifies a speaker never pays for it.
    """

    dim = EMBEDDING_DIM

    def __init__(self, *, model_dir: str = DEFAULT_MODEL_DIR,
                 source: str = DEFAULT_MODEL_SOURCE) -> None:
        self._model_dir = model_dir
        self._source = source
        self._encoder = None

    @staticmethod
    def installed() -> bool:
        """Whether the optional dependencies are present at all.

        `find_spec` rather than a real import: this is called on a health path
        and importing torch takes seconds.
        """
        from importlib.util import find_spec

        try:
            return find_spec("torch") is not None and find_spec("speechbrain") is not None
        except (ImportError, ValueError):  # pragma: no cover - broken install
            return False

    def load(self) -> None:
        if self._encoder is not None:
            return
        if not self.installed():
            raise SpeakerEmbeddingUnavailable(
                "speaker identification needs torch and speechbrain, which are not installed"
            )
        try:
            from speechbrain.inference.speaker import EncoderClassifier

            self._encoder = EncoderClassifier.from_hparams(
                source=self._source,
                savedir=self._model_dir,
                run_opts={"device": "cpu"},
            )
        except Exception as exc:  # noqa: BLE001 - any failure here is the same failure
            raise SpeakerEmbeddingUnavailable(
                f"the speaker embedding model could not be loaded: {type(exc).__name__}"
            ) from exc
        logger.info("Speaker embedding model ready (%d-dim).", self.dim)

    def embed(self, waveform: "object") -> list[float]:
        """One embedding for one speaker's concatenated speech.

        Deliberately not batched across speakers. Batching would pad every
        speaker to the longest one's length, and ECAPA's statistics pooling
        averages over the padding too — so the quiet speaker in a meeting with
        one monologuer would get an embedding diluted toward silence, which is
        a bug that only shows up in exactly the meetings this feature is for.
        """
        import numpy as np
        import torch

        self.load()
        if len(waveform) < int(MIN_SPAN_SECONDS * SAMPLE_RATE):
            raise SpeakerEmbeddingUnavailable("not enough speech to build a voiceprint")

        signal = torch.from_numpy(np.ascontiguousarray(waveform, dtype="float32")).unsqueeze(0)
        with torch.no_grad():
            embedding = self._encoder.encode_batch(signal)  # type: ignore[union-attr]
        vector = embedding.squeeze().cpu().numpy().astype("float64").tolist()

        if len(vector) != self.dim:
            # A model swap that changed the width. Fail loudly: the column is
            # vector(192), and a silent truncation would still compare to
            # something.
            raise SpeakerEmbeddingUnavailable(
                f"expected {self.dim}-dim embeddings, model returned {len(vector)}"
            )
        # No embedding is logged, here or anywhere. Only its shape.
        return vector
