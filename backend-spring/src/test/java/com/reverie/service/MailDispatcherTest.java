package com.reverie.service;

import com.reverie.entity.MailMessage;
import com.reverie.repository.MailOutboxRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Delivery, and the four ways it can be interrupted.
 *
 * <h2>The invariant being defended</h2>
 *
 * <p><b>An irreversible act and the intent to report it commit together, and a
 * provider outage after that is a delay rather than a loss.</b> The first half
 * is {@link AccountMailTest}'s and the call sites'. This is the second half:
 * given a row on the queue, nothing short of the row being marked delivered may
 * end with it undelivered.
 *
 * <p>The previous implementation had no second half at all. It sent inline and
 * wrote a date column on success, which is at-most-once — a ninety-second
 * Resend outage during the nightly retention pass permanently destroyed the
 * only notice an account holder got that their data had been deleted, and the
 * account-closed message had nothing left anywhere to be rebuilt from.
 *
 * <h2>Crashes, modelled honestly</h2>
 *
 * <p>A process dying is modelled as a row that was claimed and then abandoned
 * mid-flight, with a <em>fresh dispatcher</em> — a new instance, or the same one
 * after a restart — claiming it again. That is exactly what the database sees:
 * the claim is a row lock held by a transaction, so a killed process releases
 * it by dying, with no lease to expire and nothing to reap.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class MailDispatcherTest {

    @Mock private MailOutboxRepository outbox;
    @Mock private Mailer mailer;

    private MailDispatcher dispatcher;

    @BeforeEach
    void setUp() {
        when(mailer.enabled()).thenReturn(true);
        dispatcher = dispatcher();
    }

    /** A restart, or a second instance. Same queue, new object. */
    private MailDispatcher dispatcher() {
        return new MailDispatcher(outbox, mailer, 25, 5, 30, 3600);
    }

    private MailMessage queued(String key) {
        MailMessage m = new MailMessage();
        m.setId("mal_" + key.hashCode());
        m.setDedupeKey(key);
        m.setToAddress("ada@example.com");
        m.setSubject("Your Reverie account is closed");
        m.setBodyText("...");
        m.setBodyHtml("<p>...</p>");
        m.setUserId("usr_1");
        return m;
    }

    private void onQueue(MailMessage... messages) {
        when(outbox.claimBatch(anyInt())).thenReturn(List.of(messages));
    }

    private void providerIs(Mailer.Outcome outcome) {
        when(mailer.send(anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenReturn(outcome);
    }

    @Test
    @DisplayName("Resend is unavailable when the account deletion commits: the mail survives")
    void outageAtCommitTime() {
        /*
         * The scenario the whole redesign exists for. closeAccount has already
         * destroyed the meetings, the objects and the user row; the message is
         * the only record of it, and the provider is down.
         */
        MailMessage closure = queued("account-closed:usr_1");
        onQueue(closure);
        providerIs(Mailer.Outcome.retry("ConnectException"));

        dispatcher.deliverBatch();

        assertThat(closure.getSentAt()).isNull();
        assertThat(closure.getAbandonedAt()).as("not given up on after one failure").isNull();
        assertThat(closure.getAttemptCount()).isEqualTo(1);
        assertThat(closure.getNextAttemptAt()).isAfter(Instant.now());
        assertThat(closure.getLastError()).isEqualTo("ConnectException");
    }

    @Test
    @DisplayName("...and sends it once Resend comes back")
    void outageEnds() {
        MailMessage closure = queued("account-closed:usr_1");
        onQueue(closure);
        providerIs(Mailer.Outcome.retry("ConnectException"));
        dispatcher.deliverBatch();

        providerIs(Mailer.Outcome.ok());
        int sent = dispatcher.deliverBatch();

        assertThat(sent).isEqualTo(1);
        assertThat(closure.getSentAt()).isNotNull();
        assertThat(closure.getLastError()).as("cleared on success").isNull();
    }

    @Test
    @DisplayName("the process dies after the commit and before the send: the mail survives the restart")
    void crashBeforeSend() {
        /*
         * Nothing was attempted, so nothing was written. The row is exactly as
         * the business transaction left it, and the next process to look finds
         * it -- which is the difference between an outbox and a callback
         * registered in memory after commit, as this used to be.
         */
        MailMessage closure = queued("account-closed:usr_1");
        onQueue(closure);
        providerIs(Mailer.Outcome.ok());

        MailDispatcher afterRestart = dispatcher();
        int sent = afterRestart.deliverBatch();

        assertThat(sent).isEqualTo(1);
        assertThat(closure.getSentAt()).isNotNull();
    }

    @Test
    @DisplayName("the send succeeds and the process dies before marking it: the retry carries the same key")
    void crashAfterSend() {
        /*
         * The one gap no amount of care on this side closes, because the two
         * writes are in different systems. It is closed at the provider: every
         * attempt for a row carries that row's dedupe key as an idempotency
         * key, so Resend recognises the retry as the message it already took.
         */
        MailMessage closure = queued("account-closed:usr_1");
        onQueue(closure);
        providerIs(Mailer.Outcome.ok());

        // Delivered, and the mark never reached the database.
        dispatcher.deliverBatch();
        closure.setSentAt(null);

        dispatcher().deliverBatch();

        ArgumentCaptor<String> keys = ArgumentCaptor.forClass(String.class);
        verify(mailer, times(2)).send(anyString(), anyString(), anyString(), anyString(),
                keys.capture());
        assertThat(keys.getAllValues())
                .as("the same idempotency key both times, or the retry is a second email")
                .containsExactly("account-closed:usr_1", "account-closed:usr_1");
    }

    @Test
    @DisplayName("the retention deletion mail survives an outage the same way")
    void retentionOutage() {
        // Same guarantee, and it has to be: the pass deleted meetings and this
        // is the only thing that will ever say so.
        MailMessage digest = queued("retention-applied:usr_1:2026-03-05");
        onQueue(digest);
        providerIs(Mailer.Outcome.retry("503 Service Unavailable"));

        dispatcher.deliverBatch();
        assertThat(digest.getSentAt()).isNull();
        assertThat(digest.getAbandonedAt()).isNull();

        providerIs(Mailer.Outcome.ok());
        dispatcher().deliverBatch();

        assertThat(digest.getSentAt()).isNotNull();
    }

    @Test
    @DisplayName("backs off further each time, up to a ceiling")
    void backoff() {
        // A long outage must not become one message per second per instance,
        // and must not become a message that arrives next week either.
        MailMessage m = queued("retention-applied:usr_1:2026-03-05");
        onQueue(m);
        providerIs(Mailer.Outcome.retry("timeout"));

        dispatcher.deliverBatch();
        Instant first = m.getNextAttemptAt();
        dispatcher.deliverBatch();
        Instant second = m.getNextAttemptAt();

        assertThat(second).isAfter(first);
        assertThat(second).isBefore(Instant.now().plusSeconds(3601));
    }

    @Test
    @DisplayName("gives up eventually, and keeps the row")
    void abandons() {
        MailMessage m = queued("notes-ready:mtg_9");
        onQueue(m);
        providerIs(Mailer.Outcome.retry("timeout"));

        for (int i = 0; i < 5; i++) {
            dispatcher.deliverBatch();
        }

        assertThat(m.getAbandonedAt()).isNotNull();
        assertThat(m.getAttemptCount()).isEqualTo(5);
        // Kept, with its reason. "We could not tell them" is worth finding out.
        assertThat(m.getLastError()).isEqualTo("timeout");
    }

    @Test
    @DisplayName("retires a refusal that will be given again forever, without waiting five attempts")
    void permanentRefusal() {
        // A rejected address is not made deliverable by a fifth attempt.
        MailMessage m = queued("notes-ready:mtg_9");
        onQueue(m);
        providerIs(Mailer.Outcome.giveUp("422 Unprocessable Entity"));

        dispatcher.deliverBatch();

        assertThat(m.getAbandonedAt()).isNotNull();
        assertThat(m.getAttemptCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("claims nothing at all while no provider is configured")
    void notConfigured() {
        /*
         * The queue grows and drains later, rather than being burned through
         * against a provider that is not there -- which would abandon every
         * message in it after five attempts and call that delivery.
         */
        when(mailer.enabled()).thenReturn(false);

        assertThat(dispatcher.deliverBatch()).isZero();
        verify(outbox, never()).claimBatch(anyInt());
        verify(mailer, never()).send(anyString(), anyString(), anyString(), anyString(), anyString());
    }

    @Test
    @DisplayName("one undeliverable address does not abandon the rest of the batch")
    void oneBadApple() {
        MailMessage bad = queued("notes-ready:mtg_1");
        MailMessage good = queued("notes-ready:mtg_2");
        onQueue(bad, good);
        when(mailer.send(anyString(), anyString(), anyString(), anyString(),
                eq("notes-ready:mtg_1"))).thenReturn(Mailer.Outcome.giveUp("422"));
        when(mailer.send(anyString(), anyString(), anyString(), anyString(),
                eq("notes-ready:mtg_2"))).thenReturn(Mailer.Outcome.ok());

        int sent = dispatcher.deliverBatch();

        assertThat(sent).isEqualTo(1);
        assertThat(good.getSentAt()).isNotNull();
        assertThat(bad.getAbandonedAt()).isNotNull();
    }
}
