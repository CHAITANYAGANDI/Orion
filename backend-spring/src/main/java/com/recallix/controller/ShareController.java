package com.recallix.controller;

import com.recallix.dto.ShareCreateRequest;
import com.recallix.dto.ShareResponse;
import com.recallix.dto.SharedMeetingResponse;
import com.recallix.security.SecurityUtils;
import com.recallix.service.ShareService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Share links: authenticated management under {@code /api/v1}, and one
 * deliberately public resolution endpoint under {@code /public}.
 *
 * <p>The public route is separated by path prefix rather than by an annotation so
 * that what is unauthenticated is visible in the security config, not buried in
 * a controller.
 */
@RestController
public class ShareController {

    private final ShareService shares;

    public ShareController(ShareService shares) {
        this.shares = shares;
    }

    @PostMapping("/api/v1/meetings/{id}/share")
    public ShareResponse createShare(@PathVariable String id,
                                     @Valid @RequestBody(required = false) ShareCreateRequest req) {
        return shares.createOrUpdate(SecurityUtils.currentUserId(), id, req);
    }

    /** 204 when the meeting has no live link, so the UI can show "not shared". */
    @GetMapping("/api/v1/meetings/{id}/share")
    public ResponseEntity<ShareResponse> currentShare(@PathVariable String id) {
        return shares.current(SecurityUtils.currentUserId(), id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @DeleteMapping("/api/v1/meetings/{id}/share")
    public ResponseEntity<Void> revokeShare(@PathVariable String id) {
        shares.revoke(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }

    /** Unauthenticated. The token in the path is the only credential. */
    @GetMapping("/public/shared/{token}")
    public SharedMeetingResponse shared(@PathVariable String token) {
        return shares.resolve(token);
    }
}
