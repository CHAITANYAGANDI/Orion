"""Individual endpoint shapes (transcribe, summarize, extract-*, agent)."""

from __future__ import annotations

TRANSCRIPT = "Chaitanya will finish JWT validation on the Spring gateway by Friday."


def test_transcribe_shape(client):
    resp = client.post("/ai/transcribe", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert {"transcript", "language", "segments"} <= set(body.keys())
    assert isinstance(body["segments"], list) and body["segments"]
    assert {"start", "end", "speaker", "text"} <= set(body["segments"][0].keys())


def test_summarize_shape(client):
    resp = client.post("/ai/summarize", json={"transcript": TRANSCRIPT})
    assert resp.status_code == 200
    body = resp.json()
    assert {"shortSummary", "detailedSummary", "keyPoints"} <= set(body.keys())
    assert isinstance(body["keyPoints"], list)


def test_extract_action_items_shape(client):
    resp = client.post("/ai/extract-action-items", json={"transcript": TRANSCRIPT})
    assert resp.status_code == 200
    items = resp.json()["actionItems"]
    assert items
    for it in items:
        assert {"taskTitle", "ownerName", "dueDate", "priority", "sourceSentence"} <= set(it.keys())
        assert it["priority"] in {"high", "medium", "low"}
