package com.recallix.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.recallix.domain.SummarySection;
import com.recallix.dto.SegmentDto;
import com.recallix.dto.callback.AiInsight;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Thin HTTP client for the FastAPI ai-service (RAG chat + translation).
 * Called server-side only; the ai-service endpoints live on the internal
 * network and are not exposed to the browser.
 */
@Component
public class AiClient {

    private static final Logger log = LoggerFactory.getLogger(AiClient.class);

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

    /** A short-lived AssemblyAI streaming credential on its way to a browser. */
    public record StreamingToken(String token, int expiresInSeconds) {}

    /**
     * Mint a streaming token. Null when one could not be had.
     *
     * <p>Null rather than an exception because the caller has something useful
     * to say about it and this does not: live transcription being unavailable
     * is a degraded meeting, not a failed one, and the recording itself is
     * unaffected either way.
     *
     * <p>{@code ASSEMBLYAI_API_KEY} lives in the ai-service and is never read
     * here. What crosses this call is the token, which expires in under a
     * minute and can open exactly one streaming session.
     */
    public StreamingToken streamingToken() {
        try {
            JsonNode body = client.post()
                    .uri("/ai/streaming-token")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of())
                    .retrieve()
                    .body(JsonNode.class);
            if (body == null || !body.hasNonNull("token")) {
                return null;
            }
            return new StreamingToken(
                    body.get("token").asText(),
                    body.hasNonNull("expiresInSeconds") ? body.get("expiresInSeconds").asInt() : 45);
        } catch (RuntimeException e) {
            // The message can carry a provider response body; the class name
            // cannot, and is enough to tell a 503 from a connection refused.
            log.warn("Streaming token request failed: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    public record SearchHit(String meetingId, String meetingTitle, int chunkIndex,
                            String snippet, Double start, Double end, double score) {}

    /**
     * Ask a question about one meeting. {@code userId} is sent so the
     * ai-service can satisfy row-level security on the transcript chunks —
     * ownership is checked here too, but the database enforces it
     * independently, so a bug in that check cannot become a cross-tenant read.
     */
    public ChatResult chat(String userId, String meetingId, String question,
                           com.recallix.domain.ChatMode mode, List<String> history) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("meetingId", meetingId);
        payload.put("question", question);
        payload.put("userId", userId);
        payload.put("mode", (mode == null ? com.recallix.domain.ChatMode.QUICK : mode).wire());
        // The thread so far, so a follow-up resolves. Sent even when empty:
        // an absent list and an empty one mean the same thing downstream, and
        // a field that is only sometimes present is one somebody eventually
        // reads as significant.
        payload.put("history", history == null ? List.of() : history);
        JsonNode body = client.post()
                .uri("/ai/chat")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(JsonNode.class);
        return toChatResult(body);
    }

    /**
     * Ask a question grounded across every meeting the user owns. The ai-service
     * filters retrieval by userId, so a caller can never be grounded in another
     * user's transcripts.
     */
    public ChatResult workspaceChat(String userId, String question, List<String> meetingIds,
                                    com.recallix.domain.ChatMode mode, Integer historyDays,
                                    List<String> history) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("question", question);
        payload.put("history", history == null ? List.of() : history);
        if (meetingIds != null && !meetingIds.isEmpty()) {
            payload.put("meetingIds", meetingIds);
        }
        // Always sent, even for the default: the ai-service defaults to express
        // too, and a field that is only sometimes present is a field somebody
        // eventually reads as "unset means advanced".
        payload.put("mode", (mode == null ? com.recallix.domain.ChatMode.QUICK : mode).wire());
        // Omitted rather than sent as null when the account reads everything:
        // the ai-service treats an absent window as no floor, which is what it
        // did before the setting existed.
        if (historyDays != null) {
            payload.put("historyDays", historyDays);
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

    /**
     * Starter questions across everything one user owns.
     *
     * <p>Only the user id is sent: the ai-service reads the meetings itself,
     * exactly as workspace chat does. Assembling the material here instead
     * would put two services querying the same tables for the same purpose,
     * which is how the two come to disagree about what "recent" means.
     */
    public List<String> workspaceSuggestions(String userId) {
        return workspaceSuggestions(userId, null);
    }

    /**
     * The same, narrowed to meetings the reader selected through Add context.
     *
     * <p>Sent as ids rather than as material for the same reason as above: the
     * ai-service reads the summaries. What travels is the reader's choice.
     */
    public List<String> workspaceSuggestions(String userId, List<String> meetingIds) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        if (meetingIds != null && !meetingIds.isEmpty()) {
            payload.put("meetingIds", meetingIds);
        }
        JsonNode body = client.post()
                .uri("/ai/suggestions/workspace")
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .body(JsonNode.class);

        List<String> out = new java.util.ArrayList<>();
        if (body != null && body.has("suggestions")) {
            for (JsonNode s : body.get("suggestions")) {
                String q = s.asText("").trim();
                if (!q.isEmpty()) {
                    out.add(q);
                }
            }
        }
        return out;
    }

    /**
     * A summary as written, in the shape the requested template asked for.
     *
     * <p>{@code insights} are the decisions and risks the ai-service read back
     * out of those same sections. They ride along rather than being derived
     * here so the section-key-to-kind mapping lives in one language: duplicating
     * it in Java would let it drift from the templates it reads.
     */
    public record SummaryResult(String shortSummary,
                                String detailedSummary,
                                List<String> keyPoints,
                                List<SummarySection> sections,
                                String templateSlug,
                                List<AiInsight> insights,
                                /** Starter chat questions drawn from these sections. */
                                List<String> suggestions) {}

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
        // Absent when an older ai-service answers, which is why the list is
        // built defensively rather than assumed: a rewrite must still produce
        // notes, it simply leaves the previous decisions in place.
        List<AiInsight> insights = new java.util.ArrayList<>();
        if (body != null && body.has("insights")) {
            for (JsonNode i : body.get("insights")) {
                AiInsight parsed = new AiInsight(
                        text(i, "kind"), text(i, "text"), text(i, "sourceSection"));
                if (parsed.isUsable()) {
                    insights.add(parsed);
                }
            }
        }
        List<String> suggestions = new java.util.ArrayList<>();
        if (body != null && body.has("suggestions")) {
            for (JsonNode s : body.get("suggestions")) {
                String q = s.asText("").trim();
                if (!q.isEmpty()) {
                    suggestions.add(q);
                }
            }
        }
        return new SummaryResult(
                text(body, "shortSummary"),
                text(body, "detailedSummary"),
                keyPoints,
                sections,
                body != null && body.hasNonNull("templateSlug") ? body.get("templateSlug").asText() : null,
                insights,
                suggestions);
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
                // Absent whenever the ai-service could not place the topic
                // in the transcript, which is a normal outcome rather than a
                // fault — see SummarySection.OutlineGroup.
                Double startSeconds = g.hasNonNull("startSeconds")
                        ? g.get("startSeconds").asDouble()
                        : null;
                groups.add(new SummarySection.OutlineGroup(text(g, "heading"), gb, startSeconds));
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

    /**
     * Translate a list, keeping it a list of the same length in the same order.
     *
     * <p>Every caller indexes the result against what it sent — key points
     * against key points, utterances against the speakers who said them — so
     * the length is the contract and is checked here as well as in the
     * ai-service. A reply of the wrong size is not partially useful; it is
     * words attributed to the wrong person. Returning the untranslated source
     * on any doubt is visibly untranslated, which is a state a reader can
     * understand and act on.
     */
    public List<String> translateLines(List<String> lines, String targetLanguage) {
        if (lines == null || lines.isEmpty()) {
            return List.of();
        }
        JsonNode body = client.post()
                .uri("/ai/translate-lines")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("lines", lines, "targetLanguage", targetLanguage))
                .retrieve()
                .body(JsonNode.class);

        JsonNode out = body == null ? null : body.get("lines");
        if (out == null || !out.isArray() || out.size() != lines.size()) {
            return List.copyOf(lines);
        }
        List<String> translated = new ArrayList<>(lines.size());
        for (int i = 0; i < lines.size(); i++) {
            String value = out.get(i).asText("");
            translated.add(value.isBlank() ? lines.get(i) : value);
        }
        return translated;
    }

    private static String text(JsonNode node, String field) {
        return node != null && node.hasNonNull(field) ? node.get(field).asText() : "";
    }

    // ---------------------------------------------------------------------
    // Speaker identification
    // ---------------------------------------------------------------------
    // The voice half of the feature lives entirely in the ai-service: it holds
    // the embedding model, the encryption key and the vectors. Spring sends
    // turn boundaries and gets back proposals, and applies them itself --
    // which is why nothing below returns or accepts an embedding. A voice
    // template never crosses this boundary in either direction.

    /** One canonical speaker's turns, on their way to the embedder. */
    public record SpeakerTurns(String speakerKey, String displayName,
                               List<double[]> spans) {}

    /** A proposal: this unresolved speaker is confidently this person. */
    public record SpeakerMatch(String speakerKey, String displayName,
                               String profileId, double similarity) {}

    /**
     * The outcome of asking who the unresolved speakers are.
     *
     * <p>{@code unavailable} is the reason the question could not be asked at
     * all -- no model, no key, no database -- and is deliberately separate from
     * an empty match list. "We looked and nobody matched" and "we could not
     * look" are different sentences on screen, and a user told the first when
     * the second is true will keep pressing a button that can never work.
     */
    public record SpeakerIdentification(List<SpeakerMatch> matches, int considered,
                                        int profiles, String unavailable) {
        public boolean ran() {
            return unavailable == null;
        }
    }

    /**
     * Ask which unresolved speakers in this meeting are somebody already known.
     *
     * <p>Read-only at the far end: identification never creates or updates a
     * profile. If it did, one confident mistake would be averaged into that
     * person's template and make the next mistake likelier -- a loop that
     * degrades silently, because every individual step looks like the feature
     * working.
     *
     * <p>A transport failure is reported as unavailable rather than thrown. The
     * caller has a transcript to return either way, and the honest thing to
     * show is "matching is unavailable", not a 500 on a meeting that is fine.
     */
    public SpeakerIdentification identifySpeakers(String userId, String meetingId,
                                                  String objectKey, List<SpeakerTurns> speakers) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("meetingId", meetingId);
        payload.put("objectKey", objectKey);
        payload.put("speakers", speakers.stream().map(AiClient::speakerPayload).toList());

        try {
            JsonNode body = client.post()
                    .uri("/ai/speakers/identify")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .body(JsonNode.class);
            if (body == null) {
                return new SpeakerIdentification(List.of(), 0, 0, "Speaker matching is unavailable.");
            }
            String unavailable = body.hasNonNull("unavailable") ? body.get("unavailable").asText() : null;
            List<SpeakerMatch> matches = new ArrayList<>();
            if (body.has("matches")) {
                for (JsonNode m : body.get("matches")) {
                    matches.add(new SpeakerMatch(
                            text(m, "speakerKey"),
                            text(m, "displayName"),
                            text(m, "profileId"),
                            m.hasNonNull("similarity") ? m.get("similarity").asDouble() : 0.0));
                }
            }
            return new SpeakerIdentification(
                    matches,
                    body.hasNonNull("considered") ? body.get("considered").asInt() : 0,
                    body.hasNonNull("profiles") ? body.get("profiles").asInt() : 0,
                    unavailable);
        } catch (RuntimeException e) {
            log.warn("Speaker identification failed: {}", e.getClass().getSimpleName());
            return new SpeakerIdentification(List.of(), 0, 0, "Speaker matching is unavailable.");
        }
    }

    /**
     * Record that a voice belongs to the name a human just gave it.
     *
     * <p>Called after a manual rename, and only for an account that has switched
     * speaker learning on -- the caller checks, because the caller owns the user
     * row. Never fatal: the rename the user asked for has already been applied
     * and committed, and failing their edit because a background enrolment could
     * not run would be the wrong end of the stick entirely.
     */
    public void learnSpeaker(String userId, String meetingId, String objectKey,
                             String speakerKey, String displayName, List<SpeakerTurns> speakers) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("meetingId", meetingId);
        payload.put("objectKey", objectKey);
        payload.put("speakerKey", speakerKey);
        payload.put("displayName", displayName);
        payload.put("speakers", speakers.stream().map(AiClient::speakerPayload).toList());

        try {
            client.post()
                    .uri("/ai/speakers/learn")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .toBodilessEntity();
        } catch (RuntimeException e) {
            log.warn("Learning a speaker profile failed: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * Delete voice templates: one profile, one meeting's, or everything held.
     *
     * <p>Pass both ids as null to erase the lot, which is what switching speaker
     * learning off and closing an account both do.
     */
    public int forgetSpeakers(String userId, String profileId, String meetingId) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("profileId", profileId);
        payload.put("meetingId", meetingId);
        try {
            JsonNode body = client.post()
                    .uri("/ai/speakers/forget")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .body(JsonNode.class);
            return body != null && body.hasNonNull("deleted") ? body.get("deleted").asInt() : 0;
        } catch (RuntimeException e) {
            // Logged loudly. Everything else here degrades quietly, but a
            // deletion that did not happen is the one failure a user must not
            // be left believing succeeded -- the caller turns this into an error.
            log.error("Deleting speaker profiles failed: {}", e.getClass().getSimpleName());
            throw e;
        }
    }

    private static Map<String, Object> speakerPayload(SpeakerTurns speaker) {
        Map<String, Object> m = new java.util.HashMap<>();
        m.put("speakerKey", speaker.speakerKey());
        m.put("displayName", speaker.displayName() == null ? "" : speaker.displayName());
        m.put("spans", speaker.spans());
        return m;
    }
}
