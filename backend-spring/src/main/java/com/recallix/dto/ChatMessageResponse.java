package com.recallix.dto;

import com.fasterxml.jackson.databind.JsonNode;
import com.recallix.entity.ChatMessage;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

public record ChatMessageResponse(
        String id,
        /** Which thread this turn belongs to — see V28. */
        String conversationId,
        String role,
        String content,
        List<CitationDto> citations,
        Instant createdAt
) {
    public static ChatMessageResponse from(ChatMessage m) {
        List<CitationDto> citations = new ArrayList<>();
        JsonNode node = m.getCitations();
        if (node != null && node.isArray()) {
            for (JsonNode c : node) {
                citations.add(new CitationDto(
                        c.hasNonNull("chunkIndex") ? c.get("chunkIndex").asInt() : 0,
                        c.hasNonNull("start") ? c.get("start").asDouble() : null,
                        c.hasNonNull("end") ? c.get("end").asDouble() : null,
                        c.hasNonNull("text") ? c.get("text").asText() : "",
                        c.hasNonNull("meetingId") ? c.get("meetingId").asText() : null,
                        c.hasNonNull("meetingTitle") ? c.get("meetingTitle").asText() : null));
            }
        }
        return new ChatMessageResponse(m.getId(), m.getConversationId(), m.getRole(),
                m.getContent(), citations, m.getCreatedAt());
    }
}
