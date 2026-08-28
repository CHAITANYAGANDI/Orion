package com.orion.service;

import com.orion.common.ApiException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The limiter in front of the one endpoint that mints billable credentials.
 *
 * <p>The numbers here are the numbers the streaming-token endpoint uses — 30
 * requests per user per 10 minutes — because the point of these tests is that
 * removing Redis did not move the boundary. A clock is injected rather than
 * slept through: the alternative is a ten-minute test or a limiter whose window
 * is only tested at a length nobody ships.
 */
class RateLimitServiceTest {

    private static final String BUCKET = "streaming-token";
    private static final int LIMIT = 30;
    private static final Duration WINDOW = Duration.ofMinutes(10);
    private static final Instant T0 = Instant.parse("2026-08-25T09:00:00Z");

    /** A clock the test moves by hand. */
    private static final class MovableClock extends Clock {
        private Instant now;

        MovableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override public Instant instant() { return now; }
        @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
    }

    private static void call(RateLimitService service, String user) {
        service.checkOrThrow(BUCKET, user, LIMIT, WINDOW);
    }

    @Nested
    @DisplayName("the boundary")
    class Boundary {

        @Test
        @DisplayName("lets an ordinary request through")
        void allowsOne() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));

            assertThatCode(() -> call(service, "usr_1")).doesNotThrowAnyException();
        }

        @Test
        @DisplayName("allows exactly 30 in the window")
        void allowsThirty() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));

            for (int i = 1; i <= 30; i++) {
                int attempt = i;
                assertThatCode(() -> call(service, "usr_1"))
                        .as("request %d of 30", attempt)
                        .doesNotThrowAnyException();
            }
        }

        @Test
        @DisplayName("refuses the 31st")
        void refusesThirtyFirst() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));
            for (int i = 0; i < 30; i++) {
                call(service, "usr_1");
            }

            assertThatThrownBy(() -> call(service, "usr_1"))
                    .isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("keeps refusing while the window is open")
        void staysRefused() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));
            for (int i = 0; i < 31; i++) {
                try {
                    call(service, "usr_1");
                } catch (ApiException ignored) {
                    // The 31st.
                }
            }

            // A refusal must not reset the count, or a client in a retry loop
            // would be served every other request forever.
            assertThatThrownBy(() -> call(service, "usr_1")).isInstanceOf(ApiException.class);
        }
    }

    @Nested
    @DisplayName("what the caller sees")
    class Refusal {

        @Test
        @DisplayName("is a 429 carrying the same code and wording as before")
        void statusAndMessage() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));
            for (int i = 0; i < 30; i++) {
                call(service, "usr_1");
            }

            // Pinned because this is the contract the frontend and any client
            // retry logic sees; the storage behind the counter is not.
            assertThatThrownBy(() -> call(service, "usr_1"))
                    .isInstanceOfSatisfying(ApiException.class, e -> {
                        assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                        assertThat(e.getErrorCode()).isEqualTo("USAGE_LIMIT_REACHED");
                        assertThat(e.getMessage()).isEqualTo("Too many requests; please slow down.");
                    });
        }
    }

    @Nested
    @DisplayName("the window")
    class TheWindow {

        @Test
        @DisplayName("resets after ten minutes")
        void resetsAfterTenMinutes() {
            MovableClock clock = new MovableClock(T0);
            RateLimitService service = new RateLimitService(clock);
            for (int i = 0; i < 30; i++) {
                call(service, "usr_1");
            }
            assertThatThrownBy(() -> call(service, "usr_1")).isInstanceOf(ApiException.class);

            clock.advance(Duration.ofMinutes(10));

            assertThatCode(() -> call(service, "usr_1")).doesNotThrowAnyException();
        }

        @Test
        @DisplayName("does not reset a second early")
        void notASecondEarly() {
            MovableClock clock = new MovableClock(T0);
            RateLimitService service = new RateLimitService(clock);
            for (int i = 0; i < 30; i++) {
                call(service, "usr_1");
            }

            clock.advance(Duration.ofMinutes(10).minusSeconds(1));

            assertThatThrownBy(() -> call(service, "usr_1")).isInstanceOf(ApiException.class);
        }

        @Test
        @DisplayName("is fixed, not extended by continued use")
        void notSlidingOnUse() {
            // A TTL refreshed on every request would let a client that keeps
            // knocking stay blocked forever. The window ends when it ends.
            MovableClock clock = new MovableClock(T0);
            RateLimitService service = new RateLimitService(clock);
            for (int i = 0; i < 30; i++) {
                call(service, "usr_1");
            }
            for (int minute = 0; minute < 9; minute++) {
                clock.advance(Duration.ofMinutes(1));
                assertThatThrownBy(() -> call(service, "usr_1")).isInstanceOf(ApiException.class);
            }

            clock.advance(Duration.ofMinutes(1));

            assertThatCode(() -> call(service, "usr_1")).doesNotThrowAnyException();
        }

        @Test
        @DisplayName("gives a full fresh 30 after it turns over")
        void freshAllowance() {
            MovableClock clock = new MovableClock(T0);
            RateLimitService service = new RateLimitService(clock);
            for (int i = 0; i < 30; i++) {
                call(service, "usr_1");
            }
            clock.advance(Duration.ofMinutes(10));

            for (int i = 0; i < 30; i++) {
                call(service, "usr_1");
            }

            assertThatThrownBy(() -> call(service, "usr_1")).isInstanceOf(ApiException.class);
        }
    }

    @Nested
    @DisplayName("between users")
    class Isolation {

        @Test
        @DisplayName("one user's burst does not spend another's allowance")
        void perUser() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));
            for (int i = 0; i < 31; i++) {
                try {
                    call(service, "usr_noisy");
                } catch (ApiException ignored) {
                    // Expected on the 31st.
                }
            }

            assertThatCode(() -> call(service, "usr_quiet")).doesNotThrowAnyException();
        }

        @Test
        @DisplayName("buckets are separate too, so one endpoint cannot exhaust another")
        void perBucket() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));
            for (int i = 0; i < 30; i++) {
                service.checkOrThrow("streaming-token", "usr_1", LIMIT, WINDOW);
            }

            assertThatCode(() -> service.checkOrThrow("some-other-bucket", "usr_1", LIMIT, WINDOW))
                    .doesNotThrowAnyException();
        }
    }

    @Nested
    @DisplayName("memory")
    class Memory {

        @Test
        @DisplayName("forgets a user whose window has ended")
        void sweepsExpired() {
            // Without this the map keeps a row per user ever seen, which is a
            // slow leak rather than a bug anybody would notice in a test.
            MovableClock clock = new MovableClock(T0);
            RateLimitService service = new RateLimitService(clock);
            for (int i = 0; i < 12_000; i++) {
                call(service, "usr_" + i);
            }
            assertThat(service.tracked()).isGreaterThan(10_000);

            clock.advance(Duration.ofMinutes(10));
            call(service, "usr_trigger");

            // The sweep runs on the next call once the map is large; everything
            // from the previous window goes with it.
            assertThat(service.tracked()).isLessThan(10_000);
        }

        @Test
        @DisplayName("keeps a user whose window is still open")
        void keepsLive() {
            RateLimitService service = new RateLimitService(new MovableClock(T0));
            for (int i = 0; i < 12_000; i++) {
                call(service, "usr_" + i);
            }

            // Still inside the window, so a sweep must not drop anybody -- doing
            // so would hand every tracked user a fresh 30. usr_0 already spent
            // one request seeding the map, so 29 more reach the limit exactly.
            assertThatCode(() -> {
                for (int i = 0; i < 29; i++) {
                    call(service, "usr_0");
                }
            }).doesNotThrowAnyException();
            assertThatThrownBy(() -> call(service, "usr_0")).isInstanceOf(ApiException.class);
        }
    }

    @Test
    @DisplayName("counts every concurrent request exactly once")
    void isThreadSafe() throws Exception {
        // The reason this is a ConcurrentHashMap.compute and not a get/put:
        // under load a lost update lets the limit be exceeded silently.
        RateLimitService service = new RateLimitService(new MovableClock(T0));
        int threads = 16;
        int callsEach = 10;   // 160 attempts against a limit of 30
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger allowed = new AtomicInteger();

        for (int t = 0; t < threads; t++) {
            pool.submit(() -> {
                start.await();
                for (int i = 0; i < callsEach; i++) {
                    try {
                        call(service, "usr_busy");
                        allowed.incrementAndGet();
                    } catch (ApiException ignored) {
                        // Refused, as most of these should be.
                    }
                }
                return null;
            });
        }
        start.countDown();
        pool.shutdown();
        assertThat(pool.awaitTermination(30, TimeUnit.SECONDS)).isTrue();

        assertThat(allowed.get()).isEqualTo(LIMIT);
    }
}
