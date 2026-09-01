package com.reverie.controller;

import com.reverie.domain.NotificationKind;
import com.reverie.dto.NotificationCountResponse;
import com.reverie.dto.NotificationKindResponse;
import com.reverie.dto.NotificationResponse;
import com.reverie.dto.PageResponse;
import com.reverie.security.SecurityUtils;
import com.reverie.service.NotificationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.List;

@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {

    private final NotificationService notifications;

    public NotificationController(NotificationService notifications) {
        this.notifications = notifications;
    }

    @GetMapping
    public PageResponse<NotificationResponse> list(@RequestParam(defaultValue = "0") int page,
                                                   @RequestParam(defaultValue = "20") int size,
                                                   @RequestParam(defaultValue = "false") boolean unread) {
        return notifications.list(SecurityUtils.currentUserId(), unread, page, size);
    }

    /**
     * The badge, and the socket topic that keeps it live.
     *
     * <p>The channel is returned rather than assumed, because the browser knows
     * its Clerk identity and not the internal user id the topic is keyed by.
     * Cheap to serve, and it is what the client polls when the socket is down.
     */
    @GetMapping("/unread-count")
    public NotificationCountResponse unreadCount() {
        String userId = SecurityUtils.currentUserId();
        return new NotificationCountResponse(notifications.unreadCount(userId), userId);
    }

    /** What can be switched off, for the settings page — labels included. */
    @GetMapping("/kinds")
    public List<NotificationKindResponse> kinds() {
        // Retired kinds are excluded: nothing emits them, so a switch would be
        // a control over something that cannot happen. See NotificationKind.
        return NotificationKind.active().stream()
                .map(NotificationKindResponse::from)
                .toList();
    }

    @PostMapping("/{id}/read")
    public NotificationResponse read(@PathVariable String id) {
        return notifications.markRead(SecurityUtils.currentUserId(), id, true);
    }

    @PostMapping("/{id}/unread")
    public NotificationResponse unread(@PathVariable String id) {
        return notifications.markRead(SecurityUtils.currentUserId(), id, false);
    }

    @PostMapping("/read-all")
    public NotificationCountResponse readAll() {
        String userId = SecurityUtils.currentUserId();
        notifications.markAllRead(userId);
        return new NotificationCountResponse(notifications.unreadCount(userId), userId);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        notifications.delete(SecurityUtils.currentUserId(), id);
        return ResponseEntity.noContent().build();
    }

    /** Clear the lot. Distinct from marking read — this one is not recoverable. */
    @DeleteMapping
    public ResponseEntity<Void> clear() {
        notifications.clear(SecurityUtils.currentUserId());
        return ResponseEntity.noContent().build();
    }
}
