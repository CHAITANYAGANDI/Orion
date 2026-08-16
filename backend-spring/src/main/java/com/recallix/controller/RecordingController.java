package com.recallix.controller;

import com.recallix.security.SecurityUtils;
import com.recallix.service.NotificationService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The one thing only the browser knows.
 *
 * <p>Recallix learns about a recording when it is finished and uploaded, which
 * is the moment a meeting appears. Nothing on the server knows a recording
 * <em>started</em> — the microphone, the timer and the decision to press record
 * all live in a tab.
 *
 * <p>That would not be worth an endpoint if the answer only had to reach the tab
 * that already knows it. It is worth one because the answer has to reach the
 * other ones: a laptop recording and a phone in a pocket are the same account,
 * and "Recording started" on the second device is the difference between a
 * product and a page. Deduplicated to one an hour in
 * {@link NotificationService}, so finding a quieter room is not three
 * notifications.
 */
@RestController
@RequestMapping("/api/v1/recordings")
public class RecordingController {

    private final NotificationService notifications;

    public RecordingController(NotificationService notifications) {
        this.notifications = notifications;
    }

    @PostMapping("/started")
    public ResponseEntity<Void> started() {
        notifications.recordingStarted(SecurityUtils.currentUserId());
        return ResponseEntity.status(HttpStatus.ACCEPTED).build();
    }
}
