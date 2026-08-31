package com.orion.service;

import com.orion.repository.MailOutboxRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The retry schedule must fit inside the provider's idempotency window.
 *
 * <h2>What breaks if it does not</h2>
 *
 * <p>Delivery here is at-least-once by construction: the provider can accept a
 * message and this process can die before it records that. The single thing
 * stopping the retry from arriving as a second email is the idempotency key, and
 * <b>Resend keeps a key for 24 hours</b>. A retry attempted after that carries a
 * key the provider has forgotten, so it is a new request and is delivered — a
 * duplicate "your account has been closed and its data deleted".
 *
 * <p>Nothing in the code would fail if the schedule outgrew the window. The
 * queue would drain, the log would be quiet, and a small number of people would
 * receive two copies of the worst email this product sends. That is exactly the
 * kind of regression a constant tweak introduces silently, so it is asserted
 * against the constants themselves rather than against a number somebody wrote
 * in a comment.
 *
 * <h2>The arithmetic, for the reader</h2>
 *
 * <pre>
 *   gaps after attempts 1..11, at 30s doubling with a 1h cap:
 *     30 + 60 + 120 + 240 + 480 + 960 + 1920 + 3600 + 3600 + 3600 + 3600
 *   = 18,210 seconds = 5h 03m 30s
 *
 *   window                                = 24h
 *   fraction used                         = 21.1%
 *   margin                                = 18h 56m
 * </pre>
 */
@ExtendWith(MockitoExtension.class)
class MailRetryWindowTest {

    @Mock private MailOutboxRepository outbox;
    @Mock private Mailer mailer;

    /**
     * Built from the same defaults the {@code @Value} annotations declare.
     *
     * <p>Not from {@code application.yml}, which an operator can override, and
     * not from a Spring context. The point is the shipped schedule.
     */
    private MailDispatcher shipped() {
        return new MailDispatcher(outbox, mailer, 25, 12, 30, 3600);
    }

    @Test
    @DisplayName("every automatic attempt finishes inside Resend's 24-hour window")
    void insideTheWindow() {
        Duration span = shipped().worstCaseRetrySpan();

        assertThat(span)
                .as("the last automatic retry must still carry a key Resend remembers")
                .isLessThan(MailDispatcher.PROVIDER_IDEMPOTENCY_WINDOW);
    }

    @Test
    @DisplayName("and with enough margin that a slow tick cannot push it out")
    void withMargin() {
        /*
         * Half the window, not a hair inside it. The span excludes the relay's
         * poll interval, a stalled instance, and clock skew between the row's
         * next_attempt_at and the provider's expiry -- none of which are worth
         * modelling individually if the schedule is nowhere near the edge.
         */
        assertThat(shipped().worstCaseRetrySpan())
                .isLessThan(MailDispatcher.PROVIDER_IDEMPOTENCY_WINDOW.dividedBy(2));
    }

    @Test
    @DisplayName("is exactly 5h 03m 30s, so a change to any constant is visible here")
    void theExactNumber() {
        // Pinned deliberately. A change to the first backoff, the cap or the
        // attempt ceiling should require editing this line and saying why -- the
        // two tests above would pass silently for a long way past the point
        // where the schedule stopped being the one that was reviewed.
        assertThat(shipped().worstCaseRetrySpan()).isEqualTo(Duration.ofSeconds(18_210));
    }

    @Test
    @DisplayName("the gaps double and then hold at the cap")
    void theShape() {
        MailDispatcher d = shipped();

        assertThat(d.backoff(1)).isEqualTo(Duration.ofSeconds(30));
        assertThat(d.backoff(2)).isEqualTo(Duration.ofSeconds(60));
        assertThat(d.backoff(7)).isEqualTo(Duration.ofSeconds(1920));
        // 30 * 2^7 = 3840, which is over the cap.
        assertThat(d.backoff(8)).isEqualTo(Duration.ofHours(1));
        assertThat(d.backoff(50)).isEqualTo(Duration.ofHours(1));
    }

    @Test
    @DisplayName("a schedule that would outgrow the window fails this test")
    void theGuardActuallyGuards() {
        /*
         * Proof that the assertion has teeth, and a note on how much room the
         * shipped schedule has. Raising the cap to six hours ALONE is still
         * inside the window (14h31m), and so is twenty attempts at the current
         * cap (13h04m) -- the margin is real, and an ordinary tweak will not
         * trip this.
         *
         * Both together will: six hours and twenty attempts is 62h32m, and the
         * last eight attempts carry a key Resend has long forgotten.
         */
        assertThat(new MailDispatcher(outbox, mailer, 25, 12, 30, 6 * 3600).worstCaseRetrySpan())
                .as("a bigger cap alone is still safe")
                .isLessThan(MailDispatcher.PROVIDER_IDEMPOTENCY_WINDOW);
        assertThat(new MailDispatcher(outbox, mailer, 25, 20, 30, 3600).worstCaseRetrySpan())
                .as("more attempts alone is still safe")
                .isLessThan(MailDispatcher.PROVIDER_IDEMPOTENCY_WINDOW);

        MailDispatcher tooPatient = new MailDispatcher(outbox, mailer, 25, 20, 30, 6 * 3600);

        assertThat(tooPatient.worstCaseRetrySpan())
                .as("both together is not")
                .isGreaterThan(MailDispatcher.PROVIDER_IDEMPOTENCY_WINDOW);
    }
}
