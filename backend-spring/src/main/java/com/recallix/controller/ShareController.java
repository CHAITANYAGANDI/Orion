package com.recallix.controller;

import com.recallix.dto.ShareCreateRequest;
import com.recallix.dto.ShareEmailRequest;
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
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

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

    /** Every live link for the meeting, its moment links included. */
    @GetMapping("/api/v1/meetings/{id}/share/links")
    public List<ShareResponse> links(@PathVariable String id) {
        return shares.list(SecurityUtils.currentUserId(), id);
    }

    @DeleteMapping("/api/v1/meetings/{id}/share")
    public ResponseEntity<Void> revokeShare(@PathVariable String id) {
        shares.revoke(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }

    /** Revoke one link by id — how a single moment link is taken back. */
    @DeleteMapping("/api/v1/shares/{shareId}")
    public ResponseEntity<Void> revokeOne(@PathVariable String shareId) {
        shares.revokeById(SecurityUtils.currentUserId(), shareId);
        return ResponseEntity.noContent().build();
    }

    /**
     * Mail the existing link to some people.
     *
     * <p>Delivery, not access control: naming an address grants it nothing, and
     * the link works for whoever ends up holding it.
     */
    @PostMapping("/api/v1/meetings/{id}/share/email")
    public Map<String, Integer> emailShare(@PathVariable String id,
                                           @Valid @RequestBody ShareEmailRequest req) {
        return Map.of("sent", shares.emailLink(SecurityUtils.currentUserId(), id, req));
    }

    /**
     * Unauthenticated. The token in the path is the only credential.
     *
     * <p>The password travels in a header rather than the query string: a URL is
     * written to server logs, browser history and any proxy in between, and a
     * password that ends up in all three is not one.
     *
     * <p>401 means "this link exists and wants a password", which is the one
     * thing resolution is allowed to admit — anyone holding the token knows that
     * much already, and a reader who cannot be told to type it is simply stuck.
     */
    @GetMapping("/public/shared/{token}")
    public SharedMeetingResponse shared(
            @PathVariable String token,
            @RequestHeader(name = "X-Share-Password", required = false) String password) {
        return shares.resolve(token, password);
    }
}
