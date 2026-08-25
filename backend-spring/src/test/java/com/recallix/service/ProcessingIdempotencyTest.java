package com.recallix.service;

import com.recallix.entity.Meeting;
import com.recallix.entity.UsageLimit;
import com.recallix.repository.MeetingUsageChargeRepository;
import com.recallix.repository.UsageLimitRepository;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * Charging for work that gets reported twice.
 *
 * <p>Kafka delivery of {@code meeting_uploaded} is at-least-once, and honestly
 * so since the worker stopped auto-committing its offset. A redelivery re-runs
 * the pipeline and posts the result again, so {@code applyResult} is called
 * more than once for one piece of work. It used to charge every time, against
 * an allowance that lasts the life of the account.
 *
 * <p>What is deliberately <em>not</em> deduplicated is reprocessing. Asking
 * Recallix to transcribe a meeting again really does transcribe it again, and
 * the allowance is denominated in minutes transcribed. So the identity is the
 * processing attempt, not the meeting.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProcessingIdempotencyTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private UsageLimitRepository usageRepo;
    @Mock private UserRepository users;
    @Mock private MeetingUsageChargeRepository charges;

    private UsageLimitService service;
    private UsageLimit limit;

    /**
     * A stand-in for the primary key of {@code meeting_usage_charges}.
     *
     * <p>The real guard is {@code INSERT ... ON CONFLICT DO NOTHING}, which
     * reports a row count. This models exactly that contract — first caller
     * gets 1, everybody after gets 0 — and does it atomically, because the
     * point of the design is that the decision is the database's and not a
     * read-then-write in Java.
     */
    private Set<String> claimed;

    @BeforeEach
    void setUp() {
        claimed = java.util.Collections.synchronizedSet(new HashSet<>());
        service = new UsageLimitService(usageRepo, users, charges);

        limit = new UsageLimit();
        limit.setId("usg_1");
        limit.setUserId(USER);
        when(usageRepo.findByUserId(USER)).thenReturn(Optional.of(limit));

        when(charges.claim(anyString(), anyInt(), anyString(), anyInt()))
                .thenAnswer(inv -> claimed.add(inv.getArgument(0) + ":" + inv.getArgument(1)) ? 1 : 0);
    }

    @Nested
    @DisplayName("one attempt")
    class OneAttempt {

        @Test
        @DisplayName("is charged the first time it is reported")
        void chargesOnce() {
            assertThat(service.chargeAiMinutesOnce(USER, MEETING, 1, 40)).isTrue();

            assertThat(limit.getAiMinutesUsed()).isEqualTo(40);
        }

        @Test
        @DisplayName("is not charged again when the same result is delivered twice")
        void doesNotChargeTwice() {
            service.chargeAiMinutesOnce(USER, MEETING, 1, 40);

            assertThat(service.chargeAiMinutesOnce(USER, MEETING, 1, 40)).isFalse();
            assertThat(limit.getAiMinutesUsed()).isEqualTo(40);
        }

        @Test
        @DisplayName("is not charged again however many times it arrives")
        void survivesABurst() {
            for (int i = 0; i < 20; i++) {
                service.chargeAiMinutesOnce(USER, MEETING, 1, 40);
            }

            assertThat(limit.getAiMinutesUsed()).isEqualTo(40);
        }
    }

    @Nested
    @DisplayName("reprocessing")
    class Reprocessing {

        @Test
        @DisplayName("is charged again, because it transcribes again")
        void chargesEachAttempt() {
            // The behaviour that existed before any of this, and the reason the
            // key is not the meeting id: a meeting-scoped guard would have made
            // every reprocess free.
            service.chargeAiMinutesOnce(USER, MEETING, 1, 40);

            assertThat(service.chargeAiMinutesOnce(USER, MEETING, 2, 40)).isTrue();
            assertThat(limit.getAiMinutesUsed()).isEqualTo(80);
        }

        @Test
        @DisplayName("is itself protected against a duplicate")
        void secondAttemptIsAlsoIdempotent() {
            service.chargeAiMinutesOnce(USER, MEETING, 1, 40);
            service.chargeAiMinutesOnce(USER, MEETING, 2, 40);

            assertThat(service.chargeAiMinutesOnce(USER, MEETING, 2, 40)).isFalse();
            assertThat(limit.getAiMinutesUsed()).isEqualTo(80);
        }
    }

    @Nested
    @DisplayName("between meetings")
    class Isolation {

        @Test
        @DisplayName("one meeting's charge does not cover another's")
        void perMeeting() {
            service.chargeAiMinutesOnce(USER, MEETING, 1, 40);

            assertThat(service.chargeAiMinutesOnce(USER, "mtg_2", 1, 10)).isTrue();
            assertThat(limit.getAiMinutesUsed()).isEqualTo(50);
        }
    }

    @Test
    @DisplayName("two duplicate callbacks arriving together charge once, not twice")
    void concurrentDuplicatesChargeOnce() throws Exception {
        // The reason this is a unique constraint and not
        //     if (!alreadyCharged) { charge(); markCharged(); }
        // Both callers pass that check before either writes, and the account is
        // billed twice for one piece of work.
        int threads = 16;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger charged = new AtomicInteger();

        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                start.await();
                if (service.chargeAiMinutesOnce(USER, MEETING, 1, 40)) {
                    charged.incrementAndGet();
                }
                return null;
            });
        }
        start.countDown();
        pool.shutdown();
        assertThat(pool.awaitTermination(30, TimeUnit.SECONDS)).isTrue();

        assertThat(charged.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("a meeting with no duration is not charged at all")
    void zeroMinutesStillClaims() {
        // Claimed but worth nothing: the row records that this attempt was
        // settled, so a redelivery cannot later charge it for a duration that
        // arrives second time around.
        assertThat(service.chargeAiMinutesOnce(USER, MEETING, 1, 0)).isTrue();

        assertThat(limit.getAiMinutesUsed()).isZero();
        assertThat(service.chargeAiMinutesOnce(USER, MEETING, 1, 40)).isFalse();
    }
}
