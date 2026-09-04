package com.reverie.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.reverie.domain.SummarySection;
import com.reverie.dto.SegmentDto;
import com.reverie.dto.callback.AiInsight;
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

    /** Bounded, for the one call a user waits on synchronously. */
    private final RestClient indexClient;

    /**
     * How long re-indexing may take before the edit that triggered it gives up.
     *
     * <p>The JDK's {@code HttpClient} has no read timeout unless one is set, so
     * an unbounded call waits forever — and {@link #reindex} is made inside a
     * user's own request, in a transaction, in one case while the meeting row is
     * locked. An ai-service that is cold, restarting or wedged then hangs the
     * correction with no error and nothing on screen but a disabled button, and
     * every retry queues behind the first.
     *
     * <p>Generous, because embedding a long transcript is real work and giving
     * up early would leave chat stale on every edit. Finite, because indexing is
     * already best-effort — losing it means chat may quote the old text until
     * the next edit, which is a far smaller failure than never answering at all.
     *
     * <p>Only this call is bounded here. Summarizing and chatting spend a model
     * call whose honest worst case is minutes, and one timeout that suited both
     * would be too short for those or too long to be worth having.
     */
    private static final Duration INDEX_TIMEOUT = Duration.ofSeconds(30);

    public AiClient(@Value("${app.ai-service-url:http://localhost:8000}") String aiServiceUrl) {
        String baseUrl = withScheme(aiServiceUrl);
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
                .baseUrl(baseUrl)
                .build();

        // Same connection, different patience. The timeout belongs to the
        // factory rather than the request, so the bounded call needs its own.
        var indexFactory = new JdkClientHttpRequestFactory(jdkClient);
        indexFactory.setReadTimeout(INDEX_TIMEOUT);
        this.indexClient = RestClient.builder()
                .requestFactory(indexFactory)
                .baseUrl(baseUrl)
                .build();
    }

    /**
     * Puts {@code http://} in front of a bare {@code host:port}.
     *
     * <p>Render's blueprint cannot produce a URL. {@code fromService} with
     * {@code property: hostport} yields {@code reverie-ai:10000} — the right
     * host and the right port, with no scheme — and that is not a base URL:
     * {@code URI} reads {@code reverie-ai} as the scheme and the rest as an
     * opaque body, so every call fails with a parse error naming a host nobody
     * configured. Losing the auto-wiring to avoid that would mean writing the
     * private service's port out by hand and keeping it in step forever.
     *
     * <p>{@code http}, not {@code https}: this address exists only on Render's
     * internal network, where private services are plain HTTP and are not
     * reachable from outside at all.
     *
     * <p>Only this URL gets repaired. The frontend and public URLs are refused
     * by {@link com.reverie.config.DeploymentCheck} instead, because for those
     * both schemes are plausible and a wrong guess is a working deployment
     * pointing somewhere unintended.
     */
    private static String withScheme(String url) {
        String trimmed = url == null ? "" : url.trim();
        if (trimmed.isEmpty() || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            return trimmed;
        }
        log.info("AI_SERVICE_URL has no scheme; reading '{}' as http://{}", trimmed, trimmed);
        return "http://" + trimmed;
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
                           com.reverie.domain.ChatMode mode, List<String> history) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("meetingId", meetingId);
        payload.put("question", question);
        payload.put("userId", userId);
        payload.put("mode", (mode == null ? com.reverie.domain.ChatMode.QUICK : mode).wire());
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
                                    com.reverie.domain.ChatMode mode, Integer historyDays,
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
        payload.put("mode", (mode == null ? com.reverie.domain.ChatMode.QUICK : mode).wire());
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
     *
     * <p>Bounded by {@link #INDEX_TIMEOUT}: a user is waiting on this, so it
     * gives up rather than holding their edit open indefinitely.
     */
    public void reindex(String userId, String meetingId, int processingAttempt,
                        String transcript, List<SegmentDto> segments) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("userId", userId);
        payload.put("meetingId", meetingId);
        // Chunks are stored per processing run and retrieval reads the newest,
        // so a correction filed under an older run would be invisible: chat
        // would carry on answering from the text that was just fixed.
        payload.put("processingAttempt", processingAttempt);
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

        indexClient.post()
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

    /* ------------------------------ transcoding ----------------------------- */

    /**
     * What the ai-service says about one conversion.
     *
     * @param status  {@code ready}, {@code running} or {@code failed}
     * @param message a sentence for the user; only ever set when failed
     */
    public record TranscodeState(String status, String message) {

        public static final String READY = "ready";
        public static final String RUNNING = "running";
        public static final String FAILED = "failed";

        public boolean ready() {
            return READY.equals(status);
        }

        public boolean failed() {
            return FAILED.equals(status);
        }
    }

    /**
     * Make sure an MP3 copy of a recording exists, and say how far along it is.
     *
     * <p>Asked of the ai-service rather than done here for two reasons, and the
     * first is not the obvious one.
     *
     * <p><strong>The bytes must not come through Spring.</strong> A recording is
     * tens or hundreds of megabytes; reading one into this heap to feed a codec
     * would put a request-sized object in tenured space and give any logged-in
     * account a way to exhaust the API by clicking Export. The ai-service
     * streams it storage-to-storage and never holds the whole file either.
     *
     * <p><strong>ffmpeg is already there.</strong> It is installed in that image
     * and is the only thing in the stack that reads everything Reverie accepts —
     * webm/opus from a browser, m4a from a phone, wav from a desk recorder. Adding a second codec dependency to a second image
     * to do the same job would be two things to keep patched instead of one.
     *
     * <p>Returns immediately. The call starts the work or reports on work
     * already running; it never waits for a conversion to finish, because the
     * caller is a web request and the conversion is not.
     *
     * <p>A transport failure becomes {@code failed} with a sentence rather than
     * an exception. The caller is a polling endpoint, and an ai-service that is
     * restarting should tell the user to try again, not produce a 500 in a loop.
     */
    public TranscodeState transcodeToMp3(String objectKey, String targetKey) {
        Map<String, Object> payload = new java.util.HashMap<>();
        payload.put("objectKey", objectKey);
        payload.put("targetKey", targetKey);
        payload.put("format", "mp3");
        try {
            JsonNode body = client.post()
                    .uri("/ai/transcode")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .body(JsonNode.class);
            if (body == null || !body.hasNonNull("status")) {
                return new TranscodeState(TranscodeState.FAILED,
                        "The audio could not be converted just now. Try again in a moment.");
            }
            String status = body.get("status").asText();
            // The ai-service's own words when it wrote any -- "the recording
            // could not be decoded" tells somebody with a corrupt upload
            // something a status code cannot. Never a class name or a codec's
            // stderr: those are in that service's log, where they belong.
            String message = body.hasNonNull("message") ? body.get("message").asText() : null;
            return new TranscodeState(status, message);
        } catch (RuntimeException e) {
            log.warn("Transcoding {} to mp3 failed: {}", objectKey, e.getClass().getSimpleName());
            return new TranscodeState(TranscodeState.FAILED,
                    "The audio could not be converted just now. Try again in a moment.");
        }
    }
}
