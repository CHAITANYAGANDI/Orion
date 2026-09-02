#!/usr/bin/env python
"""Does the speaker embedding model actually load, here, as this user?

    python scripts/check_speaker_model.py

Prints ``MODEL LOAD: PASS`` and exits 0, or prints the sanitised failure and
exits 1. It touches no meeting, no audio and no database — the whole point is to
answer the model question on its own, because the last time it was answered it
was answered by a user's recording coming out wrong.

<h2>What it is for</h2>

`EcapaEmbedder.installed()` asks `find_spec` whether torch and speechbrain
import. They did. The weights behind them are a different question, and nothing
asked it until a meeting needed one — at which point the failure arrived dressed
as a property of the recording:

    reason=the embedding model could not be loaded
    providerSpeakers=7 usableReferences=0 regions=0 embeddingAttempts=0

The cause was that `EncoderClassifier.from_hparams` fills its `savedir` with
symlinks into the HuggingFace cache of whoever ran it — root, at image build
time — and the service runs as `ai`, which cannot read `/root`. Every file came
back `PermissionError`.

So this runs in the Dockerfile after `USER ai`, where it would have caught that,
and it is runnable by hand against a deployed container:

    docker compose exec ai python scripts/check_speaker_model.py

<h2>Safe to run anywhere</h2>

It prints package versions, a directory summary and a sanitised exception. No
tokens, no signed URLs, no audio, no transcript, no embedding — `_sanitise`
strips credential-shaped text before anything is logged, and the only vector
that exists here is checked for its length and discarded.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    from app.providers.ecapa_embedder import (
        DEFAULT_MODEL_DIR,
        EcapaEmbedder,
        SpeakerEmbeddingUnavailable,
        _directory_state,
        _sanitise,
        _versions,
    )

    print(f"versions   : {_versions()}")
    print(f"model dir  : {DEFAULT_MODEL_DIR}")
    print(f"dir state  : {_directory_state(DEFAULT_MODEL_DIR)}")

    if not EcapaEmbedder.installed():
        print("MODEL LOAD: SKIPPED (torch and speechbrain are not installed)")
        print("  Speaker refinement is optional; the service runs without it and")
        print("  reports `embedder not installed` rather than failing a meeting.")
        return 0

    embedder = EcapaEmbedder()
    try:
        embedder.load()
    except SpeakerEmbeddingUnavailable as exc:
        print(f"MODEL LOAD: FAIL ({_sanitise(exc)})")
        print("  The error line above from ai-service.voiceprint carries the")
        print("  stage, the exception type and what this user can see of the")
        print("  model directory.")
        return 1

    # Loading is the question; this is only to prove the loaded object is the
    # model and not something that merely constructed. One second of silence is
    # enough for a forward pass and says nothing about anybody.
    import numpy as np

    from app.providers.ecapa_embedder import SAMPLE_RATE

    vector = embedder.embed(np.zeros(SAMPLE_RATE, dtype="float32"))
    print(f"MODEL LOAD: PASS (dim={len(vector)})")

    # Idempotent: the second call must be free and must not re-fetch anything.
    embedder.load()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
