package com.orion.controller;

import com.orion.dto.SpeakerLearningRequest;
import com.orion.dto.SpeakerSettingsResponse;
import com.orion.security.SecurityUtils;
import com.orion.service.SpeakerIdentityService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The controls over the voices Orion has learned.
 *
 * <p><b>Deliberately not part of {@code PATCH /preferences}.</b> Every other
 * setting on that endpoint is a null-means-unchanged partial patch that the
 * settings page sends whenever anything on it moves. That is exactly the wrong
 * shape for this one: switching speaker learning off <em>deletes every voice
 * template the account holds</em>, and a destructive act should not be reachable
 * by a field that happened to serialise as {@code false} in a bulk update about
 * something else.
 *
 * <p>So it lives here, on its own, with its own verb, and the client has to mean
 * it. See {@code V53__speaker_profiles.sql} for what is being deleted and why it
 * is treated this carefully.
 */
@RestController
@RequestMapping("/api/v1/speakers")
public class SpeakerProfileController {

    private final SpeakerIdentityService speakers;

    public SpeakerProfileController(SpeakerIdentityService speakers) {
        this.speakers = speakers;
    }

    /** Whether learning is on, and every voice held for this account. */
    @GetMapping
    public SpeakerSettingsResponse get() {
        String userId = SecurityUtils.currentUserId();
        return new SpeakerSettingsResponse(
                speakers.learningEnabled(userId), speakers.list(userId));
    }

    /**
     * Turn speaker learning on, or off and erase everything held.
     *
     * <p>PUT rather than PATCH: this replaces a state outright, it is
     * idempotent, and there is no partial version of it.
     */
    @PutMapping("/learning")
    public SpeakerSettingsResponse setLearning(@Valid @RequestBody SpeakerLearningRequest req) {
        String userId = SecurityUtils.currentUserId();
        speakers.setLearningEnabled(userId, Boolean.TRUE.equals(req.enabled()));
        return new SpeakerSettingsResponse(
                speakers.learningEnabled(userId), speakers.list(userId));
    }

    /**
     * Forget one voice.
     *
     * <p>204 on success and an error on failure, with nothing in between: a
     * deletion that half worked must not come back looking like it worked.
     */
    @DeleteMapping("/profiles/{id}")
    public ResponseEntity<Void> deleteProfile(@PathVariable String id) {
        speakers.deleteProfile(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }
}
