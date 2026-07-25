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


def test_extract_decisions_shape(client):
    resp = client.post("/ai/extract-decisions", json={"transcript": TRANSCRIPT})
    assert resp.status_code == 200
    decisions = resp.json()["decisions"]
    assert decisions
    for d in decisions:
        assert {"decision", "confidence", "sourceSentence"} <= set(d.keys())
        assert d["confidence"] in {"high", "medium", "low"}


def test_extract_risks_shape(client):
    resp = client.post("/ai/extract-risks", json={"transcript": TRANSCRIPT})
    assert resp.status_code == 200
    risks = resp.json()["risks"]
    assert risks
    for r in risks:
        assert {"risk", "severity", "sourceSentence"} <= set(r.keys())
        assert r["severity"] in {"high", "medium", "low"}


def test_agent_plan_actions_shape(client):
    resp = client.post("/ai/agent/plan-actions", json={"meetingId": "mtg_1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["meetingId"] == "mtg_1"
    assert body["requiresApproval"] is True
    assert isinstance(body["actions"], list) and body["actions"]
    assert {"type", "provider", "status"} <= set(body["actions"][0].keys())


def test_agent_validate_action(client):
    ok = client.post(
        "/ai/agent/validate-action",
        json={"action": {"type": "CREATE_NOTION_NOTE", "provider": "notion"}},
    ).json()
    assert ok["valid"] is True

    blocked = client.post(
        "/ai/agent/validate-action",
        json={"action": {"type": "SEND_GMAIL_EMAIL", "provider": "gmail"}},
    ).json()
    assert blocked["valid"] is False
