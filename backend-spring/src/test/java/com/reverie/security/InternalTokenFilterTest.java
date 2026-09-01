package com.reverie.security;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * The third door: {@code /internal/**}, where the ai-service posts back.
 *
 * <p>These endpoints write a meeting's transcript, its summary and its status.
 * A forged callback can overwrite what a meeting says or mark it READY with
 * whatever it likes, and it never touches a user session to do it — so the
 * shared token is the only thing in the way.
 *
 * <p>Which is why it no longer has a default. It used to be
 * {@code dev-internal-token}, committed here and printed in the deployment
 * docs, so a deployment that never set the variable looked exactly like one
 * that did: healthy, quiet, and accepting writes from anybody who had read the
 * source. The test below is the one that would have made that visible.
 */
class InternalTokenFilterTest {

    private static final String CONFIGURED = "0f3a9c1d7e5b4a2f8c6d0e9b1a3f5c7d";

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    private static MockHttpServletRequest internalRequest(String token) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/internal/meetings/m1/result");
        request.setRequestURI("/internal/meetings/m1/result");
        if (token != null) {
            request.addHeader("X-Internal-Token", token);
        }
        return request;
    }

    private static MockHttpServletResponse run(String configured, MockHttpServletRequest request,
                                               FilterChain chain) throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        new InternalTokenFilter(configured).doFilter(request, response, chain);
        return response;
    }

    @Test
    @DisplayName("an unconfigured token refuses every internal request")
    void blankIsClosed() throws Exception {
        // The point of the change. "Not configured" now means "closed", where
        // it used to mean "open with the password from the README".
        FilterChain chain = mock(FilterChain.class);

        MockHttpServletResponse response = run("", internalRequest("anything"), chain);

        assertThat(response.getStatus()).isEqualTo(401);
        verify(chain, never()).doFilter(internalRequest("anything"), response);
    }

    @Test
    @DisplayName("an unconfigured token is not matched by an empty header either")
    void blankDoesNotMatchBlank() throws Exception {
        // The subtle one, and the reason the emptiness is checked before the
        // comparison rather than left to it: constant-time equality of two
        // empty strings is true, so an unset token would have accepted a
        // caller who sent `X-Internal-Token:` with nothing after it.
        FilterChain chain = mock(FilterChain.class);

        MockHttpServletResponse response = run("", internalRequest(""), chain);

        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    @DisplayName("a configured token still lets the ai-service through")
    void theRealTokenWorks() throws Exception {
        // The guard must not break the thing it guards: without this passing,
        // nothing is ever transcribed.
        FilterChain chain = mock(FilterChain.class);
        MockHttpServletRequest request = internalRequest(CONFIGURED);

        MockHttpServletResponse response = run(CONFIGURED, request, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        verify(chain).doFilter(request, response);
    }

    @Test
    @DisplayName("a wrong token is refused")
    void aWrongTokenIsRefused() throws Exception {
        MockHttpServletResponse response =
                run(CONFIGURED, internalRequest("nearly-right"), mock(FilterChain.class));

        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    @DisplayName("a missing header is refused")
    void aMissingHeaderIsRefused() throws Exception {
        MockHttpServletResponse response =
                run(CONFIGURED, internalRequest(null), mock(FilterChain.class));

        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    @DisplayName("everything outside /internal is none of this filter's business")
    void otherPathsPassThrough() throws Exception {
        // Including when the token is unconfigured. A blank REVERIE_INTERNAL_TOKEN
        // closes the callback endpoints; it must not close the application.
        FilterChain chain = mock(FilterChain.class);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/meetings");
        request.setRequestURI("/api/v1/meetings");

        MockHttpServletResponse response = run("", request, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        verify(chain).doFilter(request, response);
    }
}
