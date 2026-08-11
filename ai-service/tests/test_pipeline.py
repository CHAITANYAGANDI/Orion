"""Full mock pipeline: output must validate against the schema and be camelCase."""

from __future__ import annotations

from app.schemas import MeetingBriefResult


def test_process_meeting_matches_schema_and_is_camel_case(client):
    resp = client.post("/ai/process-meeting", json={"meetingId": "mtg_test_1"})
    assert resp.status_code == 200
    raw = resp.json()

    # Top-level keys are camelCase, not snake_case.
    for camel in [
        "meetingId",
        "shortSummary",
        "detailedSummary",
        "keyPoints",
        "actionItems",
        "segments",
    ]:
        assert camel in raw, f"missing camelCase key {camel}"
    for snake in ["short_summary", "action_items", "meeting_id", "key_points"]:
        assert snake not in raw, f"unexpected snake_case key {snake}"

    # Nested items are camelCase too.
    assert raw["actionItems"], "expected mock action items"
    item = raw["actionItems"][0]
    assert "taskTitle" in item and "sourceSentence" in item
    assert "task_title" not in item

    seg = raw["segments"][0]
    assert {"start", "end", "speaker", "text"} <= set(seg.keys())

    # Round-trips cleanly through the canonical Pydantic model.
    parsed = MeetingBriefResult.model_validate(raw)
    assert parsed.meeting_id == "mtg_test_1"
    assert parsed.transcript
    assert parsed.short_summary
    assert len(parsed.action_items) >= 1
    # Priority is within the allowed literal set.
    assert parsed.action_items[0].priority in {"high", "medium", "low"}


def test_process_meeting_is_deterministic(client):
    a = client.post("/ai/process-meeting", json={"meetingId": "m1"}).json()
    b = client.post("/ai/process-meeting", json={"meetingId": "m1"}).json()
    assert a == b
