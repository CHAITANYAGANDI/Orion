package com.orion.service;

import com.orion.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * The selectable summary templates, served through from the ai-service.
 *
 * <p>There is no templates table. The set is defined once in the ai-service,
 * alongside the section instructions that shape the prompt, and this class is
 * a cache in front of it. A second copy in Postgres would buy a join we never
 * need and guarantee a drift we would only notice when a summary came back in
 * a shape the picker said it would not.
 *
 * <p>The cache exists because the picker is drawn on every meeting page and the
 * list changes only on deploy. If the ai-service is down we keep serving the
 * last good answer: a stale template list is a far better outcome than a
 * meeting page that will not load.
 */
@Service
public class SummaryTemplateService {

    private static final Logger log = LoggerFactory.getLogger(SummaryTemplateService.class);

    /** Long enough that the picker costs nothing; short enough that a deploy shows up. */
    private static final Duration TTL = Duration.ofMinutes(10);

    /**
     * What the ai-service falls back to for an unknown slug. Named here so a
     * meeting can always be summarized even if the list cannot be fetched.
     */
    static final String DEFAULT_SLUG = "general";

    private final AiClient ai;
    private final Duration ttl;

    private volatile List<AiClient.SummaryTemplateSummary> cached = List.of();
    private volatile Instant fetchedAt = Instant.EPOCH;

    // Explicit, because the test seam below makes this a two-constructor class
    // and Spring will not guess which one to inject through.
    @Autowired
    public SummaryTemplateService(AiClient ai) {
        this(ai, TTL);
    }

    /**
     * Test seam. The outage behaviour that matters — a primed cache surviving
     * the ai-service going away — only happens after the entry expires, so a
     * test that cannot expire it silently asserts the cache hit instead.
     */
    SummaryTemplateService(AiClient ai, Duration ttl) {
        this.ai = ai;
        this.ttl = ttl;
    }

    public List<AiClient.SummaryTemplateSummary> list() {
        if (!cached.isEmpty() && Duration.between(fetchedAt, Instant.now()).compareTo(ttl) < 0) {
            return cached;
        }
        try {
            List<AiClient.SummaryTemplateSummary> fresh = ai.listTemplates();
            if (!fresh.isEmpty()) {
                cached = fresh;
                fetchedAt = Instant.now();
            }
        } catch (Exception e) {
            // Falls through to whatever we last had, which may be empty on a
            // cold start. Logged at warn, not error: the page still renders.
            log.warn("Could not fetch summary templates ({}); serving {} cached.",
                    e.getMessage(), cached.size());
        }
        return cached;
    }

    /**
     * Validate a slug the user picked, returning it normalised.
     *
     * <p>Rejected here rather than passed through, even though the ai-service
     * would quietly fall back to General: silently summarizing under a
     * different template than the one requested is worse than an error,
     * because the user would see notes in the wrong shape and have nothing to
     * tell them why.
     *
     * <p>A blank slug means "the default" and is accepted. If the list could
     * not be fetched at all we accept any non-blank slug rather than block the
     * request — the ai-service is the authority and will resolve it.
     */
    /**
     * The template's human name, for a transcription prompt.
     *
     * <p>"Engineering sprint review" tells a speech model what kind of language
     * to expect; "engineering-sprint-review" tells it about hyphens. Falls back
     * to a blank string rather than the slug, because a prompt containing a
     * slug is worse than a prompt containing nothing.
     */
    public String displayName(String slug) {
        if (slug == null || slug.isBlank()) {
            return "";
        }
        try {
            return list().stream()
                    .filter(t -> slug.equals(t.slug()))
                    .map(AiClient.SummaryTemplateSummary::name)
                    .filter(name -> name != null && !name.isBlank())
                    .findFirst()
                    .orElse("");
        } catch (RuntimeException e) {
            // The list is fetched from the ai-service. Prompting is an
            // improvement, not a precondition for transcribing anything.
            return "";
        }
    }

    public String requireKnown(String slug) {
        if (slug == null || slug.isBlank()) {
            return DEFAULT_SLUG;
        }
        String trimmed = slug.trim();
        List<AiClient.SummaryTemplateSummary> known = list();
        if (known.isEmpty()) {
            return trimmed;
        }
        boolean found = known.stream().anyMatch(t -> trimmed.equals(t.slug()));
        if (!found) {
            throw ApiException.badRequest("Unknown summary template: " + trimmed);
        }
        return trimmed;
    }
}
