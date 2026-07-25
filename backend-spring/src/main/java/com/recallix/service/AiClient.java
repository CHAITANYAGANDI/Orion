package com.recallix.service;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

/**
 * Thin HTTP client for the FastAPI ai-service (RAG chat + translation).
 * Called server-side only; the ai-service endpoints live on the internal
 * network and are not exposed to the browser.
 */
@Component
public class AiClient {

    private final RestClient client;

    public AiClient(@Value("${app.ai-service-url:http://localhost:8000}") String aiServiceUrl) {
        this.client = RestClient.builder().baseUrl(aiServiceUrl).build();
    }

    public record Citation(int chunkIndex, Double start, Double end, String text,
                           String meetingId, String meetingTitle) {}

    public record ChatResult(String answer, List<Citation> citations) {}

    public record SearchHit(String meetingId, String meetingTitle, int chunkIndex,
                            String snippet, Double start, Double end, double score) {}

    public ChatResult chat(String meetingId, String question) {
        JsonNode body = client.post()
                .uri("/ai/chat")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("meetingId", meetingId, "question", question))
                .retrieve()
                .body(JsonNode.class);
        return toChatResult(body);
    }

    /**
     * Ask a question grounded across every meeting the user owns. The ai-service
     * filters retrieval by userId, so a caller can never be grounded in another
     * user's transcripts.
     */
    public ChatResult workspaceChat(String userId, String question, List<String> meetingIds) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("question", question);
        if (meetingIds != null && !meetingIds.isEmpty()) {
            payload.put("meetingIds", meetingIds);
        }
        JsonNode body = client.post()
                .uri("/ai/workspace-chat")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(JsonNode.class);
        return toChatResult(body);
    }

    /** Meaning-based search across the user's transcripts (best passage per meeting). */
    public List<SearchHit> semanticSearch(String userId, String query, Integer limit) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("query", query);
        if (limit != null) {
            payload.put("limit", limit);
        }
        JsonNode body = client.post()
                .uri("/ai/semantic-search")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(JsonNode.class);

        List<SearchHit> hits = new java.util.ArrayList<>();
        if (body != null && body.has("hits")) {
            for (JsonNode h : body.get("hits")) {
                hits.add(new SearchHit(
                        text(h, "meetingId"),
                        text(h, "meetingTitle"),
                        h.hasNonNull("chunkIndex") ? h.get("chunkIndex").asInt() : 0,
                        text(h, "snippet"),
                        h.hasNonNull("start") ? h.get("start").asDouble() : null,
                        h.hasNonNull("end") ? h.get("end").asDouble() : null,
                        h.hasNonNull("score") ? h.get("score").asDouble() : 0.0));
            }
        }
        return hits;
    }

    private static ChatResult toChatResult(JsonNode body) {
        String answer = text(body, "answer");
        List<Citation> citations = new java.util.ArrayList<>();
        if (body != null && body.has("citations")) {
            for (JsonNode c : body.get("citations")) {
                citations.add(new Citation(
                        c.hasNonNull("chunkIndex") ? c.get("chunkIndex").asInt() : 0,
                        c.hasNonNull("start") ? c.get("start").asDouble() : null,
                        c.hasNonNull("end") ? c.get("end").asDouble() : null,
                        text(c, "text"),
                        c.hasNonNull("meetingId") ? c.get("meetingId").asText() : null,
                        c.hasNonNull("meetingTitle") ? c.get("meetingTitle").asText() : null));
            }
        }
        return new ChatResult(answer, citations);
    }

    public String translate(String textToTranslate, String targetLanguage) {
        JsonNode body = client.post()
                .uri("/ai/translate")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("text", textToTranslate, "targetLanguage", targetLanguage))
                .retrieve()
                .body(JsonNode.class);
        return text(body, "text");
    }

    private static String text(JsonNode node, String field) {
        return node != null && node.hasNonNull(field) ? node.get(field).asText() : "";
    }
}
