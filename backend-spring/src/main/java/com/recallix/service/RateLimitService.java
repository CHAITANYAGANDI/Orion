package com.recallix.service;

import com.recallix.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;

/**
 * Fixed-window Redis rate limiter for burst protection on hot endpoints
 * (independent of the monthly plan quota in {@link UsageLimitService}). Fails
 * open if Redis is unavailable so a cache outage never blocks the app.
 */
@Service
public class RateLimitService {

    private static final Logger log = LoggerFactory.getLogger(RateLimitService.class);

    private final StringRedisTemplate redis;

    public RateLimitService(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** Allow at most {@code limit} calls per {@code window} for a given key; throws 429 otherwise. */
    public void checkOrThrow(String bucket, String userId, int limit, Duration window) {
        String key = "ratelimit:" + bucket + ":" + userId;
        try {
            Long count = redis.opsForValue().increment(key);
            if (count != null && count == 1L) {
                redis.expire(key, window);
            }
            if (count != null && count > limit) {
                throw ApiException.usageLimitReached("Too many requests; please slow down.");
            }
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            log.debug("Rate limit check skipped (Redis unavailable): {}", e.getMessage());
        }
    }
}
