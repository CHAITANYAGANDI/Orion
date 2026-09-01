package com.reverie.service;

import com.reverie.entity.MailMessage;
import com.reverie.repository.MailOutboxRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Takes a batch of queued messages and tries to deliver them.
 *
 * <h2>Where the transaction boundary is, and why it is here</h2>
 *
 * <p>Split from {@link MailRelay} for the same reason {@code OutboxPublisher} is
 * split from {@code OutboxRelay}: the claim's locks last exactly as long as the
 * transaction, so claiming and marking have to happen inside one, and the
 * system tenant context has to be established outside it — the connection is
 * stamped when the transaction borrows it. A bean that both schedules itself
 * and opens its own transaction gets one of those two wrong quietly.
 *
 * <h2>At-least-once, and where the "once" actually comes from</h2>
 *
 * <p>There is an unavoidable gap: the provider can accept a message and this
 * process can die before it writes {@code sent_at}. No amount of care on this
 * side closes that — the two writes are in different systems. What closes it is
 * the dedupe key travelling to Resend as an idempotency key, so the retry is
 * recognised there as the same message and not delivered again. This class is
 * therefore deliberately at-least-once, and says so.
 *
 * <h2>The de-duplication is not open-ended, and this is where that is enforced</h2>
 *
 * <p><b>Resend keeps an idempotency key for 24 hours.</b> After that the same
 * key on the same message is a new request and will be delivered again. So the
 * guarantee above is not "exactly once, eventually" — it is "exactly once
 * within the provider's window", and the retry schedule has to fit inside that
 * window or the guarantee is a claim rather than a property.
 *
 * <p>It does, with room. {@link #worstCaseRetrySpan()} computes the span from
 * the same constants the retries actually use, and
 * {@code MailRetryWindowTest} asserts it against
 * {@link #PROVIDER_IDEMPOTENCY_WINDOW}. Changing the backoff, the cap or the
 * attempt ceiling past the point where a retry could fall outside the window
 * fails that test rather than quietly weakening the guarantee.
 *
 * <p><b>What is outside the window is outside the guarantee.</b> An operator who
 * manually clears {@code abandoned_at} on a dead row more than 24 hours after it
 * was queued may cause a duplicate delivery: the key has expired at Resend, and
 * there is no provider-side "was this already delivered" lookup to consult
 * instead. Resend does not offer one, so nothing here pretends otherwise. A
 * manual replay of a stale row is a decision to risk a second copy — usually the
 * right decision for an account-closure notice, and the operator's to make
 * knowingly.
 *
 * <h2>Giving up</h2>
 *
 * <p>After {@link #maxAttempts} the row is abandoned rather than retried
 * forever. A permanently rejected address — a typo'd domain, a suppressed
 * recipient — is not made deliverable by a hundredth attempt, and a queue that
 * never retires anything is a queue whose head is eventually a message nobody
 * can send. The row is kept, with its error, because "we could not tell them"
 * is itself something worth being able to find out.
 */
@Service
public class MailDispatcher {

    private static final Logger log = LoggerFactory.getLogger(MailDispatcher.class);

    /**
     * How long Resend remembers an idempotency key.
     *
     * <p>Their documented window. It is not configurable by us and not
     * negotiable, so it is a fact about the world that the retry schedule has to
     * fit inside rather than a setting. See the class note.
     */
    static final Duration PROVIDER_IDEMPOTENCY_WINDOW = Duration.ofHours(24);

    private final MailOutboxRepository outbox;
    private final Mailer mailer;
    private final int batchSize;
    private final int maxAttempts;
    private final Duration firstBackoff;
    private final Duration maxBackoff;

    public MailDispatcher(MailOutboxRepository outbox,
                          Mailer mailer,
                          @Value("${reverie.mail.batch:25}") int batchSize,
                          @Value("${reverie.mail.max-attempts:12}") int maxAttempts,
                          @Value("${reverie.mail.first-backoff-seconds:30}") long firstBackoff,
                          @Value("${reverie.mail.max-backoff-seconds:3600}") long maxBackoff) {
        this.outbox = outbox;
        this.mailer = mailer;
        this.batchSize = batchSize;
        this.maxAttempts = maxAttempts;
        this.firstBackoff = Duration.ofSeconds(firstBackoff);
        this.maxBackoff = Duration.ofSeconds(maxBackoff);
    }

    /**
     * One tick.
     *
     * @return how many messages were delivered, for the tests and the log
     */
    @Transactional
    public int deliverBatch() {
        if (!mailer.enabled()) {
            /*
             * Nothing is claimed and nothing is marked. The queue simply grows
             * until a provider is configured, and then drains -- which is the
             * behaviour a deployment that has not set RESEND_API_KEY yet wants,
             * rather than a backlog quietly expiring while nobody was looking.
             */
            return 0;
        }
        List<MailMessage> batch = outbox.claimBatch(batchSize);
        int sent = 0;
        for (MailMessage message : batch) {
            if (deliver(message)) {
                sent++;
            }
        }
        return sent;
    }

    private boolean deliver(MailMessage message) {
        message.setAttemptCount(message.getAttemptCount() + 1);

        // The dedupe key is the idempotency key. See the class note: this is the
        // only thing standing between a lost acknowledgement and a second copy.
        Mailer.Outcome outcome = mailer.send(
                message.getToAddress(), message.getSubject(),
                message.getBodyText(), message.getBodyHtml(),
                message.getDedupeKey());

        if (outcome.accepted()) {
            message.setSentAt(Instant.now());
            message.setLastError(null);
            return true;
        }

        // Already reduced to a status and a short phrase by MailError; this
        // is the belt to that pair of braces.
        message.setLastError(MailError.describe(0, outcome.reason()));

        /*
         * A refusal the provider will give again forever -- a malformed address,
         * an unverified sender -- is not worth twelve attempts. It is retired
         * now, with its reason, rather than occupying the queue for a day first.
         */
        boolean giveUp = outcome.permanent() || message.getAttemptCount() >= maxAttempts;
        if (giveUp) {
            message.setAbandonedAt(Instant.now());
            log.warn("Giving up on \"{}\" after {} attempt(s): {}",
                    message.getSubject(), message.getAttemptCount(), message.getLastError());
        } else {
            message.setNextAttemptAt(Instant.now().plus(backoff(message.getAttemptCount())));
        }
        return false;
    }

    /**
     * Doubling, capped.
     *
     * <p>Thirty seconds, then a minute, then two, up to an hour. The cap is what
     * stops a long outage turning into a message that arrives next week: an
     * hour is late for a retention warning and still useful, a day is neither.
     */
    Duration backoff(int attempt) {
        Duration wait = firstBackoff.multipliedBy(1L << Math.min(attempt - 1, 20));
        return wait.compareTo(maxBackoff) > 0 ? maxBackoff : wait;
    }

    /**
     * How long the whole automatic retry sequence can take, worst case.
     *
     * <p>Every attempt fails, so every gap is waited in full: the span from the
     * first attempt to the last is the sum of the waits after attempts 1 through
     * {@code maxAttempts - 1}. The final attempt is followed by no wait — the
     * row is abandoned.
     *
     * <p>With the shipped constants (30s first, doubling, 1h cap, 12 attempts)
     * that is 30 + 60 + 120 + 240 + 480 + 960 + 1920 seconds and then four gaps
     * at the cap: <b>18,210 seconds, or 5 hours 3 minutes 30 seconds</b>.
     *
     * <p>Derived rather than written down, so it cannot drift from the schedule
     * it describes — which is the whole point of asserting against it.
     *
     * <p>The relay's poll interval is deliberately not included. It adds at most
     * one tick per attempt, is configuration rather than schedule, and the
     * margin against the window is more than four hours.
     */
    Duration worstCaseRetrySpan() {
        Duration total = Duration.ZERO;
        for (int attempt = 1; attempt < maxAttempts; attempt++) {
            total = total.plus(backoff(attempt));
        }
        return total;
    }
}
