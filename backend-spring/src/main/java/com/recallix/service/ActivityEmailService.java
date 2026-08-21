package com.recallix.service;

import com.recallix.entity.Meeting;
import com.recallix.entity.UserEntity;
import com.recallix.event.WorkspaceActivityEvent;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;

/**
 * Two of the V43 emails: a comment landed, a highlight was made.
 *
 * <p>There were three. "Live meeting" — mail on a recording starting — went in
 * V44: the row it was modelled on means a bot joined a calendar event without
 * you, and Recallix records from a tab somebody opened on purpose, so the mail
 * only ever reported an action back to the person who had just taken it.
 *
 * <p><strong>Why these exist at all in a one-account product.</strong> Recallix
 * has one account per workspace, so both describe something the reader did
 * themselves — and a product that emails you about your own click is a product
 * nobody reads the email from. That objection is real and it is the reason both
 * are off by default and neither is a notification per event. What makes them
 * worth having is the gap between doing something and remembering it: a
 * transcript marked up this morning and forgotten by the evening. The bell only
 * works for somebody already looking at Recallix. These reach somebody who is
 * not.
 *
 * <p><strong>One a day, per switch.</strong> Reading a transcript through and
 * marking it up is one activity, not fifteen events, and fifteen messages about
 * it is how somebody writes a filter rule and stops reading the sender for good.
 * So each mail carries the day it last went out on the user row and simply does
 * not send again until tomorrow — the same shape as
 * {@code meeting_shares.open_emailed_on}. The first one of the day wins, and it
 * says plainly that it is the only one coming.
 *
 * <p>Every send is stamped only on success, so a mail server that was down for a
 * minute does not cost the day's one message.
 */
@Service
public class ActivityEmailService {

    private static final Logger log = LoggerFactory.getLogger(ActivityEmailService.class);

    /** Enough of a quote to recognise it; the rest is on the page. */
    private static final int SNIPPET = 180;

    private final UserRepository users;
    private final MeetingRepository meetings;
    private final EmailService email;
    private final String frontendUrl;

    public ActivityEmailService(UserRepository users,
                                MeetingRepository meetings,
                                EmailService email,
                                @Value("${app.frontend-url:http://localhost:3000}") String frontendUrl) {
        this.users = users;
        this.meetings = meetings;
        this.email = email;
        this.frontendUrl = frontendUrl.endsWith("/")
                ? frontendUrl.substring(0, frontendUrl.length() - 1)
                : frontendUrl;
    }

    /**
     * Send the message this event calls for, if the switches allow it.
     *
     * <p>Takes the date rather than reading the clock, so a test can put two
     * events on either side of midnight without waiting for one.
     *
     * @return true when a message was handed to the mail server
     */
    @Transactional
    public boolean send(WorkspaceActivityEvent event, LocalDate today) {
        UserEntity user = users.findById(event.userId()).orElse(null);
        if (user == null || !user.isEmailsEnabled()) {
            return false;
        }
        String to = user.effectiveRecapEmail();
        if (to == null || to.isBlank()) {
            // Not a warning: the switch cannot be on without an address unless
            // the account email was removed afterwards, and shouting about it
            // once per highlight would drown the log.
            log.debug("User {} has no address on file; skipping {}.", user.getId(), event.kind());
            return false;
        }

        return switch (event.kind()) {
            case COMMENT_ADDED -> commentAdded(user, to, event, today);
            case HIGHLIGHT_ADDED -> highlightAdded(user, to, event, today);
        };
    }

    private boolean commentAdded(UserEntity user, String to,
                                 WorkspaceActivityEvent event, LocalDate today) {
        if (!user.isCommentEmail() || today.equals(user.getCommentEmailedOn())) {
            return false;
        }
        boolean sent = email.send(to,
                "A comment was added to an action item",
                "Somebody wrote on one of your action items.\n\n"
                        + quote(event.detail())
                        + "\n" + frontendUrl + "/home\n\n"
                        + "This is the only comment email today, however many more are "
                        + "written.\n"
                        + footer("Comments"));
        if (sent) {
            user.setCommentEmailedOn(today);
        }
        return sent;
    }

    private boolean highlightAdded(UserEntity user, String to,
                                   WorkspaceActivityEvent event, LocalDate today) {
        if (!user.isHighlightEmail() || today.equals(user.getHighlightEmailedOn())) {
            return false;
        }
        String where = meetings.findById(event.subject())
                .map(Meeting::getTitle)
                .orElse("a conversation");
        boolean sent = email.send(to,
                "A highlight was added to " + where,
                "A passage was highlighted in \"" + where + "\".\n\n"
                        + quote(event.detail())
                        + "\n" + frontendUrl + "/meetings/" + event.subject() + "\n\n"
                        + "This is the only highlight email today, however many more are "
                        + "marked.\n"
                        + footer("Highlights"));
        if (sent) {
            user.setHighlightEmailedOn(today);
        }
        return sent;
    }

    /**
     * The quoted text, indented and cut.
     *
     * <p>Cut rather than sent whole because a highlight can be a paragraph, and
     * a mail that reproduces the passage in full removes the reason to open the
     * meeting — which is where the surrounding minute actually is.
     */
    private static String quote(String detail) {
        if (detail == null || detail.isBlank()) {
            return "";
        }
        String text = detail.strip();
        if (text.length() > SNIPPET) {
            text = text.substring(0, SNIPPET).stripTrailing() + "…";
        }
        return "  \"" + text + "\"\n\n";
    }

    /** Names the row on the settings page, so the switch is findable from the mail. */
    private static String footer(String row) {
        return "\n—\nSent automatically by Recallix because \"" + row + "\" is on. "
                + "Turn it off in Account Settings → Emails.";
    }
}
