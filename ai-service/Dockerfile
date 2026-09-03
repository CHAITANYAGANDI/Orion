# Reverie ai-service — FastAPI AI worker
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# ffmpeg converts whatever a browser produced — webm/opus from MediaRecorder,
# m4a from a phone, mp3 from a dictaphone — into the MP3 that Export downloads.
# It used to serve a local speaker-embedding model as well; that model is gone
# and this is not, because MP3 export is a live feature. See app/transcode.py.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# No acoustic model in this image, and deliberately none.
#
# Two were built, measured and removed: pyannote Community-1 as a second
# diarizer (docs/diarization.md section 12 has the numbers), and a local
# ECAPA-TDNN speaker embedder that refined the provider's turn boundaries and
# recognised voices across meetings (docs/speaker-identification.md). The second
# one is why this image used to carry torch, torchaudio, speechbrain and a baked
# model checkpoint, and why it was slow to start.
#
# Speaker segmentation now comes from AssemblyAI and is used as given. Speaker
# names come from what the meeting said out loud, which is a question about
# words and needs no model.

# Copy application source.
COPY app ./app
# Developer tools, not runtime: scripts/compare_modes.py proves Express and
# Advanced actually differ, and it has to run where the database is, which is
# in here.
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
RUN useradd --create-home --shell /usr/sbin/nologin ai && chown -R ai:ai /app
USER ai

# 8000, not 80: an unprivileged user cannot bind below 1024, and there is no
# reason to be down there behind a proxy anyway.
EXPOSE 8000

# Default provider is the deterministic mock so the container runs with no API key.
ENV AI_PROVIDER=mock

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
