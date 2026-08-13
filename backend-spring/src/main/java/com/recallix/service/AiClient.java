package com.recallix.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.recallix.domain.SummarySection;
import com.recallix.dto.SegmentDto;
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

    /**
     * Ask a question about one meeting. {@code userId} is sent so the
     * ai-service can satisfy row-level security on the transcript chunks —
     * ownership is checked here too, but the database enforces it
     * independently, so a bug in that check cannot become a cross-tenant read.
     */
    public ChatResult chat(String userId, String meetingId, String question) {
        JsonNode body = client.post()
                .uri("/ai/chat")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("meetingId", meetingId, "question", question, "userId", userId))
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

    // --- summary templates -------------------------------------------------- //

    /**
     * One selectable summary shape. Only what the picker needs: the section
     * instructions stay in the ai-service, which is the only place that uses
     * them, so there is nothing here to fall out of step with the prompt.
     */
    public record SummaryTemplateSummary(String slug, String name, List<String> sectionTitles) {}

    /**
     * The built-in templates. Fetched rather than mirrored so adding one is a
     * change in exactly one file; the caller is expected to cache it, since the
     * list only changes when the ai-service is redeployed.
     */
    public List<SummaryTemplateSummary> listTemplates() {
        JsonNode body = client.get()
                .uri("/ai/templates")
                .retrieve()
                .body(JsonNode.class);

        List<SummaryTemplateSummary> out = new java.util.ArrayList<>();
        if (body != null && body.isArray()) {
            for (JsonNode t : body) {
                List<String> titles = new java.util.ArrayList<>();
                if (t.has("sections")) {
                    for (JsonNode s : t.get("sections")) {
                        titles.add(text(s, "title"));
                    }
                }
                out.add(new SummaryTemplateSummary(text(t, "slug"), text(t, "name"), titles));
            }
        }
        return out;
    }

    /** A summary as written, in the shape the requested template asked for. */
    public record SummaryResult(String shortSummary,
                                String detailedSummary,
                                List<String> keyPoints,
                                List<SummarySection> sections,
                                String templateSlug) {}

    /**
     * Re-summarize an existing transcript under a named template.
     *
     * <p>Only the slug is sent: the ai-service resolves it to the section
     * instructions, so the wording that shapes the prompt never has to be
     * stored here. An unknown slug falls back to General there rather than
     * failing — a meeting should still get notes.
     */
    public SummaryResult summarize(String transcript,
                                   String templateSlug,
                                   Integer durationSeconds,
                                   Integer speakerCount) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("transcript", transcript);
        payload.put("templateSlug", templateSlug);
        if (durationSeconds != null) {
            payload.put("durationSeconds", durationSeconds);
        }
        if (speakerCount != null) {
            payload.put("speakerCount", speakerCount);
        }

        JsonNode body = client.post()
                .uri("/ai/summarize")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(JsonNode.class);

        List<String> keyPoints = new java.util.ArrayList<>();
        if (body != null && body.has("keyPoints")) {
            for (JsonNode k : body.get("keyPoints")) {
                keyPoints.add(k.asText());
            }
        }
        List<SummarySection> sections = new java.util.ArrayList<>();
        if (body != null && body.has("sections")) {
            for (JsonNode s : body.get("sections")) {
                sections.add(toSection(s));
            }
        }
        return new SummaryResult(
                text(body, "shortSummary"),
                text(body, "detailedSummary"),
                keyPoints,
                sections,
                body != null && body.hasNonNull("templateSlug") ? body.get("templateSlug").asText() : null);
    }

    private static SummarySection toSection(JsonNode s) {
        List<String> bullets = new java.util.ArrayList<>();
        if (s.has("bullets")) {
            for (JsonNode b : s.get("bullets")) {
                bullets.add(b.asText());
            }
        }
        List<SummarySection.OutlineGroup> groups = new java.util.ArrayList<>();
        if (s.has("groups")) {
            for (JsonNode g : s.get("groups")) {
                List<String> gb = new java.util.ArrayList<>();
                if (g.has("bullets")) {
                    for (JsonNode b : g.get("bullets")) {
                        gb.add(b.asText());
                    }
                }
                groups.add(new SummarySection.OutlineGroup(text(g, "heading"), gb));
            }
        }
        return new SummarySection(
                text(s, "key"), text(s, "title"), text(s, "kind"), text(s, "text"), bullets, groups);
    }

    /**
     * Re-index a meeting's transcript into pgvector, replacing what was there.
     *
     * <p>Called after the transcript is edited. Retrieval reads the indexed
     * chunks, not the segments, so an edit that is not re-indexed is invisible
     * to "ask this meeting" and to semantic search — the user corrects a name
     * and chat carries on answering with the old one.
     *
     * <p>The owner is sent because row-level security checks it; the ai-service
     * has no privilege to look one up.
     */
    public void reindex(String userId, String meetingId, String transcript, List<SegmentDto> segments) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("meetingId", meetingId);
        payload.put("transcript", transcript);
        payload.put("segments", segments.stream()
                .map(seg -> {
                    Map<String, Object> m = new java.util.HashMap<>();
                    m.put("start", seg.start());
                    m.put("end", seg.end());
                    m.put("speaker", seg.speaker());
                    m.put("text", seg.text());
                    return m;
                })
                .toList());

        client.post()
                .uri("/ai/index")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .toBodilessEntity();
    }

    public record EmailDraft(String subject, String body) {}

    /** Draft the follow-up email for a meeting, grounded in its brief. */
    public EmailDraft draftEmail(String title,
                                 String shortSummary,
                                 List<String> keyPoints,
                                 List<String> actionItems) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("title", title);
        payload.put("shortSummary", shortSummary == null ? "" : shortSummary);
        payload.put("keyPoints", keyPoints);
        payload.put("actionItems", actionItems);

        JsonNode body = client.post()
                .uri("/ai/draft-email")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(JsonNode.class);
        return new EmailDraft(text(body, "subject"), text(body, "body"));
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
