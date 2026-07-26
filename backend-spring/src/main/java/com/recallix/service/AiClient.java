package com.recallix.service;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;
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
        // Pin HTTP/1.1. RestClient's default JDK HttpClient negotiates HTTP/2 over
        // cleartext with an h2c upgrade handshake, which uvicorn rejects
        // ("Unsupported upgrade request") — the request then arrives with no body,
        // so every POST here fails with a 422 or a protocol-level 400.
        HttpClient jdkClient = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        this.client = RestClient.builder()
                .requestFactory(new JdkClientHttpRequestFactory(jdkClient))
                .baseUrl(aiServiceUrl)
                .build();
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

    // --- Meeting Memory ----------------------------------------------------- //

    public record CommitmentProbe(String id, String text, String ownerName, String dueDate) {}

    public record DecisionProbe(String id, String text) {}

    public record CommitmentVerdict(String commitmentId, String outcome, String rationale,
                                    String quote, Double start, String confidence) {}

    public record DecisionLinkResult(String earlierDecisionId, String laterDecisionId,
                                     String relation, String rationale, double similarity) {}

    public record ReconcileResult(List<CommitmentVerdict> commitmentVerdicts,
                                  List<DecisionLinkResult> decisionLinks) {
        public static ReconcileResult empty() {
            return new ReconcileResult(List.of(), List.of());
        }
    }

    /**
     * Reconcile a freshly-processed meeting against the user's memory: which
     * open commitments this meeting spoke to, and which of its decisions
     * interact with earlier ones. Both lists are routinely empty.
     */
    public ReconcileResult reconcile(String userId,
                                     String meetingId,
                                     List<CommitmentProbe> openCommitments,
                                     List<DecisionProbe> decisions) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("meetingId", meetingId);
        payload.put("openCommitments", openCommitments.stream()
                .map(c -> {
                    Map<String, Object> m = new java.util.HashMap<>();
                    m.put("id", c.id());
                    m.put("text", c.text());
                    m.put("ownerName", c.ownerName());
                    m.put("dueDate", c.dueDate());
                    return m;
                })
                .toList());
        payload.put("decisions", decisions.stream()
                .map(d -> Map.of("id", d.id(), "text", d.text()))
                .toList());

        JsonNode body = client.post()
                .uri("/ai/memory/reconcile")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(JsonNode.class);
        if (body == null) {
            return ReconcileResult.empty();
        }

        List<CommitmentVerdict> verdicts = new java.util.ArrayList<>();
        if (body.has("commitmentVerdicts")) {
            for (JsonNode v : body.get("commitmentVerdicts")) {
                verdicts.add(new CommitmentVerdict(
                        text(v, "commitmentId"),
                        text(v, "outcome"),
                        text(v, "rationale"),
                        text(v, "quote"),
                        v.hasNonNull("start") ? v.get("start").asDouble() : null,
                        text(v, "confidence")));
            }
        }
        List<DecisionLinkResult> links = new java.util.ArrayList<>();
        if (body.has("decisionLinks")) {
            for (JsonNode l : body.get("decisionLinks")) {
                links.add(new DecisionLinkResult(
                        text(l, "earlierDecisionId"),
                        text(l, "laterDecisionId"),
                        text(l, "relation"),
                        text(l, "rationale"),
                        l.hasNonNull("similarity") ? l.get("similarity").asDouble() : 0.0));
            }
        }
        return new ReconcileResult(verdicts, links);
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
