package com.recallix.controller;

import com.recallix.dto.KnownSpeakerResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.KnownSpeakerService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Names this user has applied to speakers before, offered when renaming.
 *
 * <p>There is no create endpoint on purpose: the list is written by the rename
 * itself, so it reflects names actually used rather than a separate address
 * book that would immediately drift from them.
 */
@RestController
@RequestMapping("/api/v1/speakers")
public class KnownSpeakerController {

    private final KnownSpeakerService speakers;

    public KnownSpeakerController(KnownSpeakerService speakers) {
        this.speakers = speakers;
    }

    @GetMapping
    public List<KnownSpeakerResponse> list() {
        return speakers.list(SecurityUtils.currentUserId());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        speakers.delete(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }
}
