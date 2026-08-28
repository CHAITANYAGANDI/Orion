package com.orion.common;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Which failures are the caller's and which are ours.
 *
 * <p>The distinction is not cosmetic. A 500 says the server broke, so it is
 * logged at ERROR with a stack trace and it is what a pager is pointed at — and
 * a route that answers 500 to a mistyped query string buries every real fault
 * under the noise of typos, crawlers and stale bookmarks. Three separate
 * handlers exist for exactly this reason; this covers the third.
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    private static HttpServletRequest request() {
        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getRequestURI()).thenReturn("/api/v1/meetings");
        return req;
    }

    private static MethodArgumentTypeMismatchException mismatch(String name, Object value) {
        return new MethodArgumentTypeMismatchException(value, Instant.class, name, null, null);
    }

    @Test
    @DisplayName("an unreadable query parameter is the caller's mistake, not a server fault")
    void typeMismatchIsABadRequest() {
        var response = handler.handleTypeMismatch(mismatch("from", "notadate"), request());

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().error()).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    @DisplayName("the message names the parameter, because a bare 400 does not say which")
    void namesTheParameter() {
        var response = handler.handleTypeMismatch(mismatch("from", "notadate"), request());

        assertThat(response.getBody().message()).contains("from");
    }

    @Test
    @DisplayName("the offending value is never echoed back")
    void doesNotReflectTheValue() {
        // It came from the caller. Putting it in a response body is how a
        // reflected-XSS gets its foothold, and it tells the caller nothing they
        // did not just type.
        var response = handler.handleTypeMismatch(
                mismatch("from", "<script>alert(1)</script>"), request());

        assertThat(response.getBody().message()).doesNotContain("<script>");
    }
}
