# Recallix ai-service — FastAPI AI worker
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source.
COPY app ./app
# Developer tools, not runtime: scripts/compare_modes.py proves Express and
# Advanced actually differ, and it has to run where the database and the
# embedding model are, which is in here.
COPY scripts ./scripts
COPY README.md ./

EXPOSE 8000

# Default provider is the deterministic mock so the container runs with no API key.
ENV AI_PROVIDER=mock

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
