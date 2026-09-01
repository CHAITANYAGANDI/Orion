package com.reverie.controller;

import com.reverie.common.ApiException;
import com.reverie.dto.StreamingTokenResponse;
import com.reverie.service.AiClient;
import com.reverie.service.RateLimitService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The one endpoint that hands a third-party credential to a browser.
 *
 * <p>Everything asserted here is about what it refuses to do. The happy path is
 * one line; the rest is the reason this is an endpoint rather than an
 * environment variable in the frontend bundle.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class StreamingTokenControllerTest {

    @Mock AiClient ai;
    @Mock RateLimitService rateLimit;

    StreamingTokenController controller;

    @BeforeEach
    void setUp() {
        controller = new StreamingTokenController(ai, rateLimit);
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(
                        "usr_1", null, AuthorityUtils.NO_AUTHORITIES));
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void mintsATokenForAnAuthenticatedUser() {
        when(ai.streamingToken()).thenReturn(new AiClient.StreamingToken("tmp-token", 45));

        StreamingTokenResponse response = controller.token();

        assertThat(response.token()).isEqualTo("tmp-token");
        assertThat(response.expiresInSeconds()).isEqualTo(45);
    }

    @Test
    void isRateLimitedPerUser() {
        // Without a limit this mints billable third-party credentials on
        // demand, one per request, to anybody holding a session.
        when(ai.streamingToken()).thenReturn(new AiClient.StreamingToken("tmp-token", 45));

        controller.token();

        verify(rateLimit).checkOrThrow(eq("streaming-token"), eq("usr_1"), anyInt(), any(Duration.class));
    }

    @Test
    void doesNotMintWhenTheRateLimitIsAlreadyExceeded() {
        doThrow(ApiException.usageLimitReached("Too many requests; please slow down."))
                .when(rateLimit).checkOrThrow(anyString(), anyString(), anyInt(), any(Duration.class));

        assertThatThrownBy(() -> controller.token()).isInstanceOf(ApiException.class);

        // The limit is checked *before* the provider is called, so a burst
        // costs nothing rather than costing tokens and then being refused.
        verify(ai, never()).streamingToken();
    }

    @Test
    void refusesRatherThanHandingBackAnEmptyToken() {
        // A client given "" opens a websocket that is refused, and the only
        // thing the user sees is "live text stopped" with no cause anywhere.
        when(ai.streamingToken()).thenReturn(null);

        assertThatThrownBy(() -> controller.token())
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("not available");
    }

    @Test
    void refusesABlankTokenTheSameWay() {
        when(ai.streamingToken()).thenReturn(new AiClient.StreamingToken("   ", 45));

        assertThatThrownBy(() -> controller.token()).isInstanceOf(ApiException.class);
    }

    @Test
    void requiresAUserAtAll() {
        // The endpoint sits under /api/v1/** which SecurityConfig authenticates,
        // and this is the belt: with no principal resolved there is nobody to
        // rate-limit against, and an unattributable mint is the one this must
        // never perform.
        SecurityContextHolder.clearContext();

        assertThatThrownBy(() -> controller.token()).isInstanceOf(RuntimeException.class);
        verify(ai, never()).streamingToken();
    }
}
