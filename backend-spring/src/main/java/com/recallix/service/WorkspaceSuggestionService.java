package com.recallix.service;

import com.recallix.entity.Meeting;
import com.recallix.entity.WorkspaceSuggestion;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.WorkspaceSuggestionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * Starter questions for the workspace chat, cached per user.
 *
 * <p>Unlike a meeting's, these have no moment to be generated at — a workspace
 * is never "finished processing" — so they are made on request and kept until
 * one of two things makes them wrong:
 *
 * <ul>
 *   <li><b>A meeting arrived.</b> Suggestions that name last week's meetings
 *       read as a system that has lost track of what the user is doing, and a
 *       new upload is exactly when someone looks at this page.
 *   <li><b>Time passed.</b> Otherwise a user whose archive is stable would see
 *       the same three questions for ever, which is the hard-coded list again
 *       with extra steps.
 * </ul>
 *
 * <p>Generation is never allowed to fail the request. The chips are a
 * convenience on a page that works without them, so an ai-service outage
 * returns whatever was cached — and an empty list if nothing was, which the UI
 * renders as its own static prompts.
 */
@Service
public class WorkspaceSuggestionService {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceSuggestionService.class);

    /**
     * How long a set stays fresh with no new meetings.
     *
     * <p>Six hours: long enough that opening the page repeatedly in a working
     * session is free and the chips do not shuffle under the user mid-task,
     * short enough that coming back the next morning shows something new.
     */
    private static final Duration TTL = Duration.ofHours(6);

    private final WorkspaceSuggestionRepository cache;
    private final MeetingRepository meetings;
    private final AiClient ai;
    private final Duration ttl;

    @Autowired
    public WorkspaceSuggestionService(WorkspaceSuggestionRepository cache,
                                      MeetingRepository meetings,
                                      AiClient ai) {
        this(cache, meetings, ai, TTL);
    }

    /** Test seam: the expiry behaviour is unobservable without moving the clock. */
    WorkspaceSuggestionService(WorkspaceSuggestionRepository cache,
                               MeetingRepository meetings,
                               AiClient ai,
                               Duration ttl) {
        this.cache = cache;
        this.meetings = meetings;
        this.ai = ai;
        this.ttl = ttl;
    }

    /**
     * Starter questions for the meetings the reader has selected.
     *
     * <p>Deliberately not cached. The cache above is keyed by user, because
     * there is one workspace per user and it changes slowly; a selection is a
     * different set every time somebody touches the picker, and a cache keyed
     * by user would hand the last selection's questions to the next one. It is
     * also the wrong thing to keep: these are about a choice being made right
     * now, not about the archive.
     *
     * <p>Failure is empty rather than fatal, like everything else here. The
     * chips are a convenience on a page that works without them.
     */
    public List<String> forSelection(String userId, List<String> meetingIds) {
        if (meetingIds == null || meetingIds.isEmpty()) {
            return forUser(userId);
        }
        try {
            return ai.workspaceSuggestions(userId, meetingIds);
        } catch (Exception e) {
            log.warn("Could not generate selection suggestions for {}: {}",
                    userId, e.getMessage());
            return List.of();
        }
    }

    @Transactional
    public List<String> forUser(String userId) {
        Optional<WorkspaceSuggestion> existing = cache.findById(userId);
        if (existing.isPresent() && isFresh(userId, existing.get())) {
            return existing.get().getPrompts();
        }

        List<String> fresh;
        try {
            fresh = ai.workspaceSuggestions(userId);
        } catch (Exception e) {
            // Serve what we have. A stale suggestion is a worse question, not a
            // broken page, and regenerating will be retried on the next visit.
            log.warn("Could not generate workspace suggestions for {}: {}", userId, e.getMessage());
            return existing.map(WorkspaceSuggestion::getPrompts).orElseGet(List::of);
        }

        if (fresh.isEmpty()) {
            // The model declined, or the user has no processed meetings. Not
            // cached as an empty result: caching "nothing" would keep the chips
            // blank for six hours after the user's first meeting finishes.
            return existing.map(WorkspaceSuggestion::getPrompts).orElseGet(List::of);
        }

        WorkspaceSuggestion row = existing.orElseGet(() -> {
            WorkspaceSuggestion created = new WorkspaceSuggestion();
            created.setUserId(userId);
            return created;
        });
        row.setPrompts(fresh);
        row.setGeneratedAt(Instant.now());
        cache.save(row);
        return fresh;
    }

    private boolean isFresh(String userId, WorkspaceSuggestion row) {
        Instant generated = row.getGeneratedAt();
        if (generated == null || Duration.between(generated, Instant.now()).compareTo(ttl) >= 0) {
            return false;
        }
        // A meeting that arrived after these were written is not described by
        // them, and is the most likely reason the user is on this page.
        return meetings.findFirstByUserIdOrderByCreatedAtDesc(userId)
                .map(Meeting::getCreatedAt)
                .map(latest -> !latest.isAfter(generated))
                .orElse(true);
    }
}
