package com.recallix.service;

import com.recallix.dto.EmailDraftResponse;
import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

/**
 * Mails the recap for a meeting that has just finished processing.
 *
 * <p>Opt-in per user. Guarded three ways, because the failure mode here is
 * mailing somebody something they did not ask for, or mailing it twice:
 * the preference must be on, the meeting must have a brief worth sending, and
 * it must not already have been sent. That last check is what stops a reprocess
 * — which re-fires the READY event — from re-sending the same recap.
 */
@Service
public class RecapEmailService {

    private static final Logger log = LoggerFactory.getLogger(RecapEmailService.class);

    private final MeetingRepository meetings;
    private final UserRepository users;
    private final FollowUpService followUp;
    private final EmailService email;
    private final AuditService audit;
    private final NotificationService notifications;

    public RecapEmailService(MeetingRepository meetings,
                             UserRepository users,
                             FollowUpService followUp,
                             EmailService email,
                             AuditService audit,
                             NotificationService notifications) {
        this.notifications = notifications;
        this.meetings = meetings;
        this.users = users;
        this.followUp = followUp;
        this.email = email;
        this.audit = audit;
    }

    /**
     * Draft and send the recap if the user opted in and it has not gone out yet.
     *
     * @return true when a message was sent.
     */
    @Transactional
    public boolean sendIfEnabled(String meetingId, String userId) {
        UserEntity user = users.findById(userId).orElse(null);
        if (user == null || !user.isEmailsEnabled()) {
            return false;
        }

        // The meeting is loaded before the switch is read, because which switch
        // applies depends on how the meeting arrived (V40).
        Meeting meeting = meetings.findByIdAndUserId(meetingId, userId).orElse(null);
        if (meeting == null) {
            return false;
        }
        if (!wanted(user, meeting)) {
            return false;
        }

        String to = user.effectiveRecapEmail();
        if (to == null || to.isBlank()) {
            log.warn("User {} enabled recap email but has no address on file.", userId);
            return false;
        }

        if (meeting.getRecapSentAt() != null) {
            log.debug("Recap for {} already sent at {}; skipping.", meetingId, meeting.getRecapSentAt());
            return false;
        }

        EmailDraftResponse draft;
        try {
            draft = followUp.draft(userId, meetingId);
        } catch (Exception e) {
            // Usually "no brief to draft from yet" — a meeting that produced
            // nothing worth mailing. Not an error worth alarming about.
            log.info("No recap drafted for {}: {}", meetingId, e.getMessage());
            return false;
        }

        boolean sent = email.send(to, draft.subject(), withFooter(draft.body(), meeting));
        if (sent) {
            // Only stamped on success, so a transient SMTP outage leaves the
            // recap eligible to go out on the next reprocess.
            meeting.setRecapSentAt(Instant.now());
            audit.record(userId, "RECAP_EMAIL_SENT", "meeting", meetingId);
            notifications.recapSent(meeting, to);
        }
        return sent;
    }

    /**
     * Whether this user asked for a recap of <em>this</em> meeting.
     *
     * <p>Two switches rather than one, because recording a call and importing an
     * archive are different acts at wildly different volumes. Somebody who
     * imports sixty files does not want sixty emails, and before V40 the only
     * way to stop them was to give up recaps for the meetings they actually
     * attended.
     *
     * <p>A meeting is "recorded" only when the recorder said so. Everything
     * else — uploads, YouTube links, documents — counts as imported, which is
     * the reading that matches where the file was captured.
     */
    private static boolean wanted(UserEntity user, Meeting meeting) {
        return meeting.isRecorded() ? user.isAutoEmailRecap() : user.isRecapForImports();
    }

    /**
     * Names the row on the settings page that sent this, not just the tab.
     *
     * <p>Which row depends on how the meeting arrived — the same split that
     * decided whether to send at all. Eight switches share that tab now, and a
     * footer saying only "Emails" leaves the reader to guess which of them to
     * turn off; the wrong guess costs them the recaps they wanted to keep.
     */
    private static String withFooter(String body, Meeting meeting) {
        String row = meeting.isRecorded() ? "Meeting summary" : "Imported conversation";
        return body + "\n\n—\nSent automatically by Recallix because \"" + row + "\" is on. "
                + "Turn it off in Account Settings → Emails.";
    }
}
