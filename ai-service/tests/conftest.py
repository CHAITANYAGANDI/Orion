"""Shared pytest fixtures. Forces mock provider; no network required."""

from __future__ import annotations

import os

os.environ.setdefault("AI_PROVIDER", "mock")
# Point Kafka at an unroutable broker; the worker retries in the background and
# never blocks the app, so tests run fully offline.
os.environ.setdefault("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="session")
def client() -> TestClient:
    # The context manager runs startup/shutdown (lifespan) once for the session.
    with TestClient(app) as c:
        yield c
