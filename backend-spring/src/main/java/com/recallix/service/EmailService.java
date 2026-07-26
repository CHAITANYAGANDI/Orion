package com.recallix.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.MailException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;

/**
 * Sends plain-text mail.
 *
 * <p>Deliberately forgiving: a recap that fails to send must not fail the
 * meeting that produced it, and the whole stack has to keep booting when no
 * SMTP server is configured at all. Every failure is logged and swallowed, and
 * the caller learns the outcome from the boolean rather than an exception.
 *
 * <p>In development this points at Mailpit, so mail is captured locally and
 * never reaches a real inbox.
 */
@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);

    private final JavaMailSender mailSender;
    private final String from;
    private final boolean enabled;

    public EmailService(JavaMailSender mailSender,
                        @Value("${recallix.mail.from:recallix@localhost}") String from,
                        @Value("${recallix.mail.enabled:true}") boolean enabled) {
        this.mailSender = mailSender;
        this.from = from;
        this.enabled = enabled;
    }

    /**
     * Send a plain-text message.
     *
     * @return true when the message was handed to the SMTP server.
     */
    public boolean send(String to, String subject, String body) {
        if (!enabled) {
            log.debug("Mail disabled; not sending '{}' to {}.", subject, to);
            return false;
        }
        if (to == null || to.isBlank()) {
            log.warn("No destination address; not sending '{}'.", subject);
            return false;
        }

        SimpleMailMessage message = new SimpleMailMessage();
        message.setFrom(from);
        message.setTo(to.trim());
        message.setSubject(subject);
        message.setText(body);

        try {
            mailSender.send(message);
            log.info("Sent '{}' to {}.", subject, to);
            return true;
        } catch (MailException e) {
            // Never rethrow: the meeting is already processed and persisted, and
            // an unreachable mail server is not a reason to fail it.
            log.warn("Could not send '{}' to {}: {}", subject, to, e.getMessage());
            return false;
        }
    }
}
