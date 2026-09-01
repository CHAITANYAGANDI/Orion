package com.reverie.service;

import com.reverie.common.ApiException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Fixed-window rate limiter for burst protection on hot endpoints, held in
 * memory (independent of the account allowance in {@link UsageLimitService}).
 *
 * <p><strong>Why not Redis.</strong> This was a Redis counter, and Redis bought
 * exactly one thing: a counter shared between backend instances. Reverie runs
 * a single instance and must — {@code OutboxPublisher.publishBatch()} selects
 * unpublished rows with no row lock, so a second instance would publish every
 * event twice and pay for every transcription twice. Until that query claims
 * rows, a shared counter has nothing to share with, and a map here is exactly
 * as correct as a round trip to another machine.
 *
 * <p><strong>It no longer fails open.</strong> The Redis version swallowed
 * connection errors and let the request through, which meant an outage silently
 * removed the limit from an endpoint that mints billable third-party
 * credentials. A map cannot be unavailable, so the limit now always applies.
 * That is a strengthening, not a change of contract: the observable behaviour
 * when Redis was reachable is the behaviour in every case now.
 *
 * <p>Windows are fixed rather than sliding, matching what the Redis
 * {@code INCR} + {@code EXPIRE} pair did: the first request of a window starts
 * the clock, and the whole window expires at once rather than decaying.
 */
@Service
public class RateLimitService {

    /**
     * When to sweep expired windows.
     *
     * <p>The map is keyed by bucket and user, so it grows with people seen
     * rather than with requests — but nothing removes the entry of somebody who
     * never comes back, and "small in practice" is not "bounded". Sweeping on a
     * size threshold rather than a timer keeps the check itself allocation-free
     * and the bound real, at the cost of one O(n) pass per threshold crossing.
     */
    private static final int SWEEP_THRESHOLD = 10_000;

    private final Clock clock;
    private final ConcurrentMap<String, Window> windows = new ConcurrentHashMap<>();

    @Autowired
    public RateLimitService() {
        this(Clock.systemUTC());
    }

    /** Visible for tests, so expiry can be exercised without waiting ten minutes. */
    RateLimitService(Clock clock) {
        this.clock = clock;
    }

    /** Allow at most {@code limit} calls per {@code window} for a given key; throws 429 otherwise. */
    public void checkOrThrow(String bucket, String userId, int limit, Duration window) {
        String key = bucket + ":" + userId;
        Instant now = clock.instant();

        if (windows.size() >= SWEEP_THRESHOLD) {
            sweep(now);
        }

        // Choosing the window, counting this request, and reading back our own
        // position are one atomic step: compute holds the bin's lock for the
        // whole function. Counting outside it would let a concurrent request
        // land in between and push our own total over the limit, refusing the
        // thirtieth caller for the thirty-first caller's arrival.
        int[] position = new int[1];
        windows.compute(key, (k, existing) -> {
            Window w = existing == null || existing.hasExpired(now)
                    ? new Window(now.plus(window))
                    : existing;
            position[0] = w.tally();
            return w;
        });

        if (position[0] > limit) {
            throw ApiException.usageLimitReached("Too many requests; please slow down.");
        }
    }

    /** Drop every window that has already ended. */
    private void sweep(Instant now) {
        windows.values().removeIf(w -> w.hasExpired(now));
    }

    /** Visible for tests: how many users are being tracked right now. */
    int tracked() {
        return windows.size();
    }

    /**
     * One user's allowance for one window.
     *
     * <p>{@code expiresAt} is fixed when the window opens and never extended,
     * so a steady stream of requests cannot hold a window open indefinitely the
     * way a refreshed TTL would.
     */
    private static final class Window {
        private final Instant expiresAt;
        /** Only ever touched inside {@code ConcurrentHashMap.compute}, which serialises it. */
        private int count;

        Window(Instant expiresAt) {
            this.expiresAt = expiresAt;
        }

        boolean hasExpired(Instant now) {
            return !now.isBefore(expiresAt);
        }

        /** Count this request and return the running total, first call included. */
        int tally() {
            return ++count;
        }
    }
}
