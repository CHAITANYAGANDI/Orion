package com.recallix.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.recallix.entity.AgentActionRequest;

/** Phase 2: a drafted/approved/executed external action. */
public record AgentActionResponse(
        String id,
        String meetingId,
        String type,
        String provider,
        String title,
        String subject,
        String body,
        Integer taskCount,
        String status
) {
    public static AgentActionResponse from(AgentActionRequest a) {
        JsonNode p = a.getDraftPayload();
        return new AgentActionResponse(
                a.getId(),
                a.getMeetingId(),
                a.getActionType(),
                a.getProvider(),
                text(p, "title"),
                text(p, "subject"),
                text(p, "body"),
                p != null && p.hasNonNull("taskCount") ? p.get("taskCount").asInt() : null,
                a.getStatus()
        );
    }

    private static String text(JsonNode node, String field) {
        return node != null && node.hasNonNull(field) ? node.get(field).asText() : null;
    }
}
