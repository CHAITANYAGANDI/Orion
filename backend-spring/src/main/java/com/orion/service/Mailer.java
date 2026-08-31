package com.orion.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The one place a message leaves Recallix.
 *
 * <h2>Why an HTTP call and not SMTP</h2>
 *
 * <p>Resend's REST API rather than {@code spring-boot-starter-mail}. SMTP from
 * a web process means a socket held open for the length of a handshake against
 * a host that may be slow, and the failure it produces is a stack trace rather
 * than a reason. This is one POST with a timeout, and a refusal comes back as a
 * status code and a body saying which address was rejected — which is what lets
 * {@link MailDispatcher} tell "try again in a minute" from "this will never
 * work".
 *
 * <h2>The idempotency key is not optional</h2>
 *
 * <p>Delivery here is at-least-once and cannot be anything else: the provider
 * can accept a message and this process can die before it records that, and no
 * discipline on this side closes a gap that spans two systems. What closes it is
 * the key. Every attempt for a given queued message carries the same
 * {@code Idempotency-Key}, so Resend recognises the retry as the message it
 * already took rather than as a second one.
 *
 * <p>It is the outbox row's {@code dedupe_key}, deliberately — one identifier
 * for "which message is this", used by the unique index that stops it being
 * queued twice and by the provider that stops it being sent twice. Two
 * identifiers for one idea is how they end up disagreeing.
 *
 * <h2>Nothing sends until it is configured</h2>
 *
 * <p>Off unless {@code RESEND_API_KEY} and {@code ORION_MAIL_FROM} are both
 * set, and that is not a convenience: a half-configured deployment that sends
 * from a domain it does not own gets the domain classified as spam, and unlike
 * most misconfigurations that one is not undone by fixing the setting. While it
 * is off the queue simply grows, and drains when a provider appears.
 *
 * <h2>This never throws</h2>
 *
 * <p>It answers with an {@link Outcome}. The caller is a relay draining a
 * batch, and one undeliverable address must not abandon the other
 * twenty-four.
 */
@Component
public class Mailer {

    private static final Logger log = LoggerFactory.getLogger(Mailer.class);

    /** Long enough for a slow provider, short enough not to hold a tick open. */
    private static final Duration TIMEOUT = Duration.ofSeconds(10);

    /**
     * What happened, in the only terms the caller acts on.
     *
     * @param accepted  the provider took it
     * @param permanent it refused in a way it will refuse again forever, so
     *                  retrying is only a way of finding that out repeatedly
     * @param reason    what to record on the row; never the body
     */
    public record Outcome(boolean accepted, boolean permanent, String reason) {

        static Outcome ok() {
            return new Outcome(true, false, null);
        }

        static Outcome retry(String reason) {
            return new Outcome(false, false, reason);
        }

        static Outcome giveUp(String reason) {
            return new Outcome(false, true, reason);
        }
    }

    private final RestClient client;
    private final String apiKey;
    private final String from;
    private final String replyTo;
    private final boolean enabled;

    /*
     * One default per decision. application.yml resolves RESEND_API_KEY and
     * friends, which makes these properties present -- and a @Value default only
     * applies to an ABSENT property, so a second default written here would be
     * dead code that reads as a fallback. The same trap the orion.auth-mode
     * comment in that file describes.
     */
    public Mailer(@Value("${orion.mail.api-key:}") String apiKey,
                  @Value("${orion.mail.from:}") String from,
                  @Value("${orion.mail.reply-to:}") String replyTo,
                  @Value("${orion.mail.base-url:https://api.resend.com}") String baseUrl) {
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.from = from == null ? "" : from.trim();
        this.replyTo = replyTo == null ? "" : replyTo.trim();
        this.enabled = !this.apiKey.isEmpty() && !this.from.isEmpty();

        HttpClient jdk = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(TIMEOUT)
                .build();
        this.client = RestClient.builder()
                .requestFactory(new JdkClientHttpRequestFactory(jdk))
                .baseUrl(baseUrl)
                .build();

        if (!this.enabled) {
            log.info("Mail is off: set RESEND_API_KEY and ORION_MAIL_FROM to switch it on. "
                    + "Queued messages will wait rather than expire.");
        }
    }

    /** Whether a send would go anywhere. The relay claims nothing if not. */
    public boolean enabled() {
        return enabled;
    }

    /**
     * Deliver one queued message.
     *
     * <p>Both bodies are sent. The text part is not a fallback nobody reads: it
     * is what a screen reader, a terminal client and a spam filter see, and a
     * message with only an HTML part is scored worse for it.
     *
     * @param idempotencyKey the outbox row's dedupe key; see the class note
     */
    public Outcome send(String to, String subject, String text, String html, String idempotencyKey) {
        if (!enabled) {
            return Outcome.retry("Mail is not configured.");
        }
        if (to == null || to.isBlank()) {
            // Nothing will make this deliverable. An account with no address on
            // it is a real state -- provisioning never had one to store.
            return Outcome.giveUp("No address");
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("from", from);
        body.put("to", List.of(to.trim()));
        body.put("subject", subject);
        body.put("text", text);
        body.put("html", html);
        if (!replyTo.isEmpty()) {
            body.put("reply_to", replyTo);
        }

        try {
            client.post()
                    .uri("/emails")
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey)
                    .header("Idempotency-Key", idempotencyKey)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .toBodilessEntity();
            return Outcome.ok();
        } catch (HttpClientErrorException e) {
            /*
             * 4xx is the provider saying no on its own terms. 422 is a rejected
             * address or an unverified sender and will be rejected identically
             * tomorrow; 429 is rate limiting and is exactly what backoff is for.
             * 401 and 403 are configuration and would burn the whole queue
             * against a wrong key, so they are retried rather than retired --
             * fixing the key should drain the backlog, not find it empty.
             */
            /*
             * Only the status and the reason phrase, through MailError. NOT
             * e.getMessage(), which Spring assembles from the response BODY --
             * and a provider that echoes a submitted header back on a 401 would
             * then put a live API key into a column that is kept for a month and
             * survives the deletion of the account.
             */
            int status = e.getStatusCode().value();
            String reason = MailError.describe(status, e.getStatusText());
            if (status == 429 || status == 401 || status == 403) {
                return Outcome.retry(reason);
            }
            return Outcome.giveUp(reason);
        } catch (RuntimeException e) {
            /*
             * A timeout, a refused connection, a 5xx. Transient by assumption,
             * which is the safe assumption: retrying something permanent costs
             * a few log lines, and retiring something transient costs the
             * message.
             *
             * The address is not logged. These are account addresses, and the
             * log is the one place they would be readable by somebody who is
             * not the account holder.
             */
            log.warn("Could not send \"{}\": {}", subject, e.getClass().getSimpleName());
            // The class name, not the message: a class name is a Java identifier
            // chosen by a library author, a message is whatever came back.
            return Outcome.retry(MailError.describe(e));
        }
    }
}
