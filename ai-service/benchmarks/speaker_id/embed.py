"""Audio in, one voiceprint out — by the same route the product takes.

Every step here is imported from `app.providers.ecapa_embedder` and called in
the order `SpeakerIdentityService.voiceprints_for` calls it:

    decode_to_pcm  ->  choose_spans  ->  take_spans  ->  EcapaEmbedder.embed

Nothing is reimplemented, because a benchmark that computes its embeddings
slightly differently from the product measures a system nobody ships. The one
thing this file decides for itself is what the *spans* are, and the answer is
"the whole clip": a benchmark recording is one person talking, so the span the
diarizer would have produced is the file.

That is worth stating plainly, because it is the single place the benchmark and
production differ in kind. In a real meeting a speaker's spans exclude the parts
where somebody else was talking, so `speech_seconds` is speech. Here it is
elapsed time, and every pause inside the clip counts toward it. Two consequences
follow, both handled rather than ignored:

* the recording instructions ask for continuous speech, so the two numbers stay
  close;
* `choose_spans` is still applied, so the 45-second ceiling and the 0.8-second
  floor that production imposes are imposed here too.

Raw vectors never leave this module in printable form. What the rest of the
harness gets is the vector for arithmetic and a short fingerprint for the
report — see `fingerprint`.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Voiceprint:
    """One clip reduced to the same thing a meeting speaker is reduced to."""

    #: The 192 floats. Held in memory, never printed, never written to disk.
    vector: list[float]
    #: What `choose_spans` kept, which is what the matcher's min-seconds rule
    #: is tested against — not the file's duration.
    speech_seconds: float
    #: The file's own length, for the report's "you asked for 20s, you recorded
    #: 18.4s" column.
    clip_seconds: float


def fingerprint(vector: list[float]) -> str:
    """Twelve hex characters that identify a vector without disclosing one.

    A SHA-256 of the packed floats, truncated. One-way, so it is not the
    embedding under a different name, and it earns its place: it is how a reader
    of the CSV notices that two rows they believed were separate takes are
    byte-identical because a file was copied rather than re-recorded. That
    mistake produces a suspiciously perfect same-person score and is otherwise
    invisible.
    """
    packed = struct.pack(f"<{len(vector)}d", *vector)
    return hashlib.sha256(packed).hexdigest()[:12]


class Embedder:
    """The production ECAPA model, loaded once for the whole run."""

    def __init__(self) -> None:
        from app.providers.ecapa_embedder import EcapaEmbedder

        self._embedder = EcapaEmbedder()

    @staticmethod
    def available() -> tuple[bool, str]:
        """Whether this can run at all, and what to do if not."""
        from app.providers.ecapa_embedder import EcapaEmbedder

        if not EcapaEmbedder.installed():
            return False, (
                "torch and speechbrain are not installed in this interpreter.\n"
                "The benchmark must run inside the ai-service image, which has "
                "both and has the ECAPA weights baked into /opt/models/ecapa.\n"
                "See benchmarks/speaker_id/README.md for the command."
            )
        return True, ""

    def of(self, path: Path, *, limit_seconds: float | None = None) -> Voiceprint:
        """Embed one file, optionally only its first `limit_seconds`.

        The limit is how the duration sweep works: the same take, cut shorter,
        so the only thing that changed between two rows is how much speech the
        model was given. It is a prefix rather than a random window because that
        is what a short turn in a meeting is — somebody started talking and
        stopped.
        """
        from app.providers.ecapa_embedder import (
            SAMPLE_RATE,
            choose_spans,
            decode_to_pcm,
            take_spans,
        )

        pcm = decode_to_pcm(path.read_bytes())
        clip_seconds = len(pcm) / float(SAMPLE_RATE)

        end = clip_seconds if limit_seconds is None else min(clip_seconds, float(limit_seconds))
        picked = choose_spans([(0.0, end)])
        if not picked.spans:
            from app.providers.ecapa_embedder import SpeakerEmbeddingUnavailable

            raise SpeakerEmbeddingUnavailable(
                f"{path.name}: nothing usable in the first {end:.1f}s"
            )

        vector = self._embedder.embed(take_spans(pcm, picked.spans))
        return Voiceprint(
            vector=vector,
            speech_seconds=picked.seconds,
            clip_seconds=clip_seconds,
        )
