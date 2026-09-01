package com.reverie.controller;

import com.reverie.common.ApiException;
import com.reverie.dto.StreamingTokenResponse;
import com.reverie.security.SecurityUtils;
import com.reverie.service.AiClient;
import com.reverie.service.RateLimitService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;

/**
 * A credential the browser may hold, for the length of one meeting start.
 *
 * <p>Live transcription streams microphone audio from the tab directly to
 * AssemblyAI. That is the right shape — relaying every 50ms frame through
 * Reverie would add a hop to the one part of the product where latency
 * <em>is</em> the feature — but it means something has to authenticate that
 * socket from JavaScript, and {@code ASSEMBLYAI_API_KEY} must never be it. A
 * key in a bundle is a key in every user's devtools, valid for the whole
 * account, until somebody notices.
 *
 * <p>So the key stays in the ai-service, this endpoint stands in front of it,
 * and what comes back is a token that expires in under a minute and can do
 * exactly one thing: open a streaming session.
 *
 * <p><b>Rate limited, and not as a formality.</b> Without a limit this is an
 * endpoint that mints billable third-party credentials on demand, one per
 * request, to anybody with a session. The limit is generous enough for the
 * reconnects a bad network causes during a real meeting and far below what a
 * script would want.
 *
 * <p>Nothing is stored. There is no revocation list because there is nothing
 * worth revoking for the seconds a token lives, and a token written down
 * somewhere is a token that outlives its own expiry.
 */
@RestController
@RequestMapping("/api/v1/streaming")
public class StreamingTokenController {

    private static final Logger log = LoggerFactory.getLogger(StreamingTokenController.class);

    /**
     * Enough for a long meeting with a flaky connection.
     *
     * <p>One token opens one session. A meeting that drops and reconnects every
     * few minutes for an hour is well inside this; a loop asking for tokens is
     * not.
     */
    private static final int TOKENS_PER_WINDOW = 30;
    private static final Duration WINDOW = Duration.ofMinutes(10);

    private final AiClient ai;
    private final RateLimitService rateLimit;

    public StreamingTokenController(AiClient ai, RateLimitService rateLimit) {
        this.ai = ai;
        this.rateLimit = rateLimit;
    }

    @PostMapping("/token")
    public StreamingTokenResponse token() {
        String userId = SecurityUtils.currentUserId();
        rateLimit.checkOrThrow("streaming-token", userId, TOKENS_PER_WINDOW, WINDOW);

        AiClient.StreamingToken minted = ai.streamingToken();
        if (minted == null || minted.token().isBlank()) {
            // Deliberately not a 200 with an empty string. A client handed one
            // opens a websocket that is refused, and the only thing the user
            // sees is "live text stopped" with no cause anywhere.
            log.warn("Streaming token unavailable for user {}", userId);
            throw ApiException.badRequest("Live transcription is not available right now.");
        }
        // The length, never the value.
        log.debug("Minted streaming token ({} chars) for {}", minted.token().length(), userId);
        return new StreamingTokenResponse(minted.token(), minted.expiresInSeconds());
    }
}
