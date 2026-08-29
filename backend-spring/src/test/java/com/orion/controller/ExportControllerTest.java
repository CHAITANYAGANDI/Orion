package com.orion.controller;

import com.orion.common.ApiException;
import com.orion.domain.ExportFormat;
import com.orion.domain.ExportOptions;
import com.orion.dto.AudioDownloadResponse;
import com.orion.dto.AudioExportResponse;
import com.orion.export.ExportFile;
import com.orion.service.ExportService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Which URL reaches which method, and whose meeting it asks for.
 *
 * <h2>Why this file exists</h2>
 *
 * <p>MP3 export was reported failing with "Meeting not found" on a meeting whose
 * summary and transcript exported perfectly. That message is written by exactly
 * one line — {@code findByIdAndUserId} coming back empty in
 * {@code ExportService} — so producing it requires the route to exist, the
 * caller to be authenticated, and the identity to be wrong. Two of those three
 * are decided here, in the controller, and neither was covered by a test: the
 * service tests call the service directly, so a swapped argument or a mistyped
 * path would have passed every one of them.
 *
 * <p>So this asserts the two things the service can never see. <b>The routes
 * resolve</b> — {@code /audio/mp3} is its own mapping and does not collide with
 * {@code /audio}, which sits one segment above it — and <b>all three export
 * endpoints hand the service the same pair</b>: the authenticated user from the
 * security context, and the meeting id from the path, in that order.
 *
 * <p>{@code standaloneSetup} rather than a full context, because the question is
 * about request mapping and argument binding rather than about beans, and
 * booting the application needs a PostgreSQL with fifty Flyway migrations on it.
 * What this does not prove is the filter chain — that a request arrives
 * authenticated at all — which {@code AuthenticationFilter} owns and its own
 * tests cover.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ExportControllerTest {

    private static final String USER = "usr_1";
    private static final String MEETING = "mtg_1";

    @Mock private ExportService exports;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        mvc = MockMvcBuilders.standaloneSetup(new ExportController(exports)).build();
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(USER, null, AuthorityUtils.NO_AUTHORITIES));

        when(exports.render(anyString(), anyString(), any(ExportFormat.class),
                any(ExportOptions.class), any(), any()))
                .thenReturn(new ExportFile("sprint-planning.txt", "text/plain",
                        "rendered".getBytes(StandardCharsets.UTF_8)));
        when(exports.audio(anyString(), anyString()))
                .thenReturn(new AudioDownloadResponse("https://r2/signed", "a.webm", "audio/webm", 900));
        when(exports.audioAsMp3(anyString(), anyString()))
                .thenReturn(AudioExportResponse.preparing());
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("the document export resolves")
    void documentExportResolves() throws Exception {
        mvc.perform(get("/api/v1/meetings/{id}/export", MEETING).param("format", "txt"))
                .andExpect(status().isOk());
    }

    @Test
    @DisplayName("the mp3 export resolves, and is not the same route as /audio")
    void mp3ExportResolves() throws Exception {
        // The pattern is /api/v1/meetings/{id}/audio/mp3, one segment deeper
        // than /audio. If it had ever been shadowed by the shorter mapping, or
        // simply not registered, this is where it shows -- and on a build
        // without it the request 404s with "Not found" rather than reaching the
        // service at all, which is the distinction the whole investigation
        // turned on.
        mvc.perform(get("/api/v1/meetings/{id}/audio/mp3", MEETING))
                .andExpect(status().isOk());

        verify(exports).audioAsMp3(anyString(), anyString());
        verify(exports, never()).audio(anyString(), anyString());
    }

    @Test
    @DisplayName("/audio still reaches the original endpoint")
    void originalAudioStillResolves() throws Exception {
        mvc.perform(get("/api/v1/meetings/{id}/audio", MEETING))
                .andExpect(status().isOk());

        verify(exports).audio(USER, MEETING);
        verify(exports, never()).audioAsMp3(anyString(), anyString());
    }

    @Test
    @DisplayName("every export endpoint asks for the same meeting, as the same user")
    void identityIsTheSameEverywhere() throws Exception {
        // The regression. All three read the caller from one place and the
        // meeting from one place; a difference between them is the only way the
        // documents can export while the MP3 reports the meeting missing.
        mvc.perform(get("/api/v1/meetings/{id}/export", MEETING).param("format", "txt"));
        mvc.perform(get("/api/v1/meetings/{id}/audio", MEETING));
        mvc.perform(get("/api/v1/meetings/{id}/audio/mp3", MEETING));

        verify(exports).render(eq(USER), eq(MEETING), any(ExportFormat.class),
                any(ExportOptions.class), any(), any());
        verify(exports).audio(USER, MEETING);
        // Positional, so a swapped (meetingId, userId) fails here rather than
        // in production as a 404 nobody can explain.
        verify(exports).audioAsMp3(USER, MEETING);
    }

    @Test
    @DisplayName("the path is the meeting id, verbatim")
    void thePathIsTheMeetingId() throws Exception {
        // Ids are opaque. If anything in the mapping ever truncated or decoded
        // one differently between the two endpoints, the lookup would fail for
        // one and succeed for the other -- which is precisely the reported
        // symptom.
        for (String id : new String[]{"mtg_1", "mtg_ABC-123", "01J8Z9Q0000000000000000000"}) {
            mvc.perform(get("/api/v1/meetings/{id}/export", id).param("format", "txt"));
            mvc.perform(get("/api/v1/meetings/{id}/audio/mp3", id));

            verify(exports).render(eq(USER), eq(id), any(ExportFormat.class),
                    any(ExportOptions.class), any(), any());
            verify(exports).audioAsMp3(USER, id);
        }
    }

    @Test
    @DisplayName("an unauthenticated caller is refused rather than looked up as somebody")
    void unauthenticatedIsRefused() {
        SecurityContextHolder.clearContext();

        assertThatThrownBy(() -> mvc.perform(get("/api/v1/meetings/{id}/audio/mp3", MEETING)))
                .rootCause()
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Authentication required");

        // The distinction that matters: no session must never become a lookup
        // for a user called something else, which would report the meeting
        // missing and look exactly like the meeting being missing.
        verify(exports, never()).audioAsMp3(anyString(), anyString());
    }

    @Test
    @DisplayName("a preparing answer is a 200, not an error")
    void preparingIsNotAnError() throws Exception {
        // `preparing` is the ordinary answer while a conversion runs. A status
        // code that said otherwise would make every poll look like a failure in
        // logs and in the browser's network panel.
        mvc.perform(get("/api/v1/meetings/{id}/audio/mp3", MEETING))
                .andExpect(status().isOk());
    }

    @Test
    @DisplayName("a ready answer carries the link and the type")
    void readyCarriesTheLink() throws Exception {
        when(exports.audioAsMp3(anyString(), anyString())).thenReturn(
                AudioExportResponse.ready("https://r2/signed.mp3", "sprint-planning.mp3",
                        "audio/mpeg", 900));

        String body = mvc.perform(get("/api/v1/meetings/{id}/audio/mp3", MEETING))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();

        assertThat(body).contains("\"status\":\"ready\"");
        assertThat(body).contains("sprint-planning.mp3");
        assertThat(body).contains("audio/mpeg");
    }
}
