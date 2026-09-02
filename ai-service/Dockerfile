# Reverie ai-service — FastAPI AI worker
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# ffmpeg decodes whatever a browser produced — webm/opus from MediaRecorder,
# m4a from a phone, mp3 from a dictaphone — into the 16 kHz mono PCM the
# speaker embedder needs. Invoked on stdin/stdout, so no audio is ever written
# to disk. See app/providers/ecapa_embedder.py.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Torch and torchaudio, from the CPU index rather than PyPI.
#
# Two reasons, and the second one is not obvious. First, the default Linux wheel
# bundles the CUDA runtime — well over a gigabyte of GPU libraries this service
# will never call, on a container that has no GPU.
#
# Second, torchaudio ships a compiled extension linked against one specific
# torch build, and the two are pinned to the same minor on purpose. torchaudio
# is in maintenance and has stopped following torch's releases, so an open range
# resolves to torch 2.13 beside torchaudio 2.11 — which installs cleanly and
# then fails at import with `OSError: Could not load this library:
# _torchaudio.abi3.so`. Installing the matched pair here, before
# requirements.txt, is also what stops pip pulling a PyPI torchaudio in as a
# transitive dependency of speechbrain.
#
# Nothing in Reverie calls torchaudio. It is here only because speechbrain
# imports it at module load; decoding audio is ffmpeg's job.
#
# Its own layer so that editing requirements.txt does not re-download either.
RUN pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        "torch==2.11.*" "torchaudio==2.11.*"

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the speaker embedding model into the image.
#
# SpeechBrain would otherwise fetch it from HuggingFace on first use, which
# turns the first "Rematch speakers" of a deployment into a _slow_ one, and
# fails outright anywhere egress is restricted. Downloading at build time makes
# the image self-contained and the runtime behaviour identical everywhere.
#
# `from_hparams` does not put the weights in `savedir`, and that is the whole
# bug this shape exists to prevent. It downloads them into the HuggingFace cache
# — `$HOME/.cache/huggingface`, and this step runs as root — and then fills
# `savedir` with **symlinks** pointing there:
#
#   /opt/models/ecapa/embedding_model.ckpt
#     -> /root/.cache/huggingface/hub/models--speechbrain--.../embedding_model.ckpt
#
# That is invisible at build time and fatal at run time. The service drops to
# the `ai` user below and `/root` is mode 0700 on this base image, so every one
# of the five files came back `PermissionError: [Errno 13]`. The model never
# loaded, `SpeakerRefiner` reported "no usable reference audio", and acoustic
# speaker refinement was silently off for every meeting on the deployment.
#
# So the links are dereferenced into a real directory and the cache is dropped.
# `cp -rL` follows them, and the image is no larger for it because the cache it
# copies out of goes in the same layer.
#
# Left owned by root and world-readable rather than chowned to `ai`. Nothing at
# run time writes here — with the files present, SpeechBrain's `fetch()` returns
# early and never touches the directory — and a model an exploited process
# cannot overwrite is worth more than one it can.
RUN python -c "from speechbrain.inference.speaker import EncoderClassifier; \
EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb', \
savedir='/opt/models/ecapa-linked', run_opts={'device': 'cpu'})" \
    && mkdir -p /opt/models/ecapa \
    && cp -rL /opt/models/ecapa-linked/. /opt/models/ecapa/ \
    && rm -rf /opt/models/ecapa-linked /root/.cache/huggingface \
    && chmod -R a+rX /opt/models/ecapa

# There is deliberately no second diarizer in this image. pyannote Community-1
# was built, benchmarked and removed -- docs/diarization.md section 12 has the
# numbers, and they are the reason. Speaker segmentation comes from AssemblyAI
# and is refined by the ECAPA model above.

# Copy application source.
COPY app ./app
# Developer tools, not runtime: scripts/compare_modes.py proves Express and
# Advanced actually differ, and it has to run where the database and the
# embedding model are, which is in here.
COPY scripts ./scripts
COPY README.md ./

# Drop root.
#
# This container was running as root, unlike the other two -- backend-spring
# runs as `app`, frontend as `nextjs`. It matters more here than anywhere else
# in the stack: this is the service that takes an arbitrary media file from an
# untrusted uploader and feeds it to ffmpeg, which is a large C codebase with a
# long history of parser CVEs. If anything in that chain is ever exploited, the
# difference between root and not is the difference between a compromised
# request and a compromised container.
#
# --no-create-home: nothing here writes to a home directory, and
# PYTHONDONTWRITEBYTECODE is already set so Python will not try to leave .pyc
# files beside the source.
#
# The model baked in above lives in /opt/models/ecapa and is read-only at
# runtime; world-readable is what the build leaves it as, which is all this
# needs.
RUN useradd --create-home --shell /usr/sbin/nologin ai && chown -R ai:ai /app
USER ai

# Prove the model loads **as the user that will run it**.
#
# This is the check that would have caught the symlink bug above at build time
# instead of in production. The bake succeeded as root, the load failed as `ai`,
# and nothing in between ever tried it from the runtime side — so the image
# shipped, deployed green, and disabled a feature silently.
#
# It fails the build rather than the deployment on purpose: a broken image
# should not reach Render at all. `scripts/check_speaker_model.py` is the same
# check, runnable against a running container.
RUN python scripts/check_speaker_model.py

# 8000, not 80: an unprivileged user cannot bind below 1024, and there is no
# reason to be down there behind a proxy anyway.
EXPOSE 8000

# Default provider is the deterministic mock so the container runs with no API key.
ENV AI_PROVIDER=mock

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
