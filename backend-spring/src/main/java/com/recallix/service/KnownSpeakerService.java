package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.common.IdGenerator;
import com.recallix.dto.KnownSpeakerResponse;
import com.recallix.entity.KnownSpeaker;
import com.recallix.repository.KnownSpeakerRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;

/**
 * The names a user has given to speakers before.
 *
 * <p>Learned rather than typed into a settings page: every rename records the
 * name, so the list fills itself from ordinary use. That matters because a
 * feature that needs seeding before it helps anyone gets seeded by nobody.
 */
@Service
public class KnownSpeakerService {

    private static final Logger log = LoggerFactory.getLogger(KnownSpeakerService.class);

    /**
     * Diarization placeholders. Recording these would fill the suggestion list
     * with "Speaker 1" — the exact label the feature exists to replace.
     */
    private static final java.util.regex.Pattern PLACEHOLDER =
            java.util.regex.Pattern.compile("^(speaker|spk|s)\\s*\\d+$", java.util.regex.Pattern.CASE_INSENSITIVE);

    private final KnownSpeakerRepository speakers;

    public KnownSpeakerService(KnownSpeakerRepository speakers) {
        this.speakers = speakers;
    }

    @Transactional(readOnly = true)
    public List<KnownSpeakerResponse> list(String userId) {
        return speakers.findByUserIdOrderByTimesUsedDescLastUsedAtDesc(userId).stream()
                .map(KnownSpeakerResponse::from)
                .toList();
    }

    @Transactional
    public void delete(String userId, String speakerId) {
        KnownSpeaker speaker = speakers.findByIdAndUserId(speakerId, userId)
                .orElseThrow(() -> ApiException.notFound("Known speaker not found"));
        speakers.delete(speaker);
    }

    /**
     * Record names the user just applied, so they are offered next time.
     *
     * <p>Failure is logged and swallowed. This is a convenience that rides on
     * the back of a rename, and a rename that the user asked for must not fail
     * because remembering the name for later did not work.
     */
    @Transactional
    public void remember(String userId, Collection<String> names) {
        for (String raw : names) {
            String name = raw == null ? "" : raw.trim();
            if (name.isBlank() || PLACEHOLDER.matcher(name).matches()) {
                continue;
            }
            try {
                speakers.findByUserIdAndNameIgnoreCase(userId, name).ifPresentOrElse(
                        existing -> {
                            existing.setTimesUsed(existing.getTimesUsed() + 1);
                            existing.setLastUsedAt(Instant.now());
                            // Adopt the newest spelling: a user who retypes
                            // "alice" as "Alice" means the latter.
                            existing.setDisplayName(name);
                        },
                        () -> {
                            KnownSpeaker fresh = new KnownSpeaker();
                            fresh.setId(IdGenerator.knownSpeaker());
                            fresh.setUserId(userId);
                            fresh.setDisplayName(name);
                            speakers.save(fresh);
                        });
            } catch (Exception e) {
                log.warn("Could not remember speaker name for user {}: {}", userId, e.toString());
            }
        }
    }
}
