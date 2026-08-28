package com.orion.service;

import com.orion.common.ApiException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The template list, served through from the ai-service.
 *
 * <p>Two behaviours matter more than the happy path. The picker is drawn on
 * every meeting page, so an uncached list would put an HTTP call on a hot read;
 * and the ai-service being briefly unreachable must degrade to a stale list
 * rather than a page that will not load.
 */
@ExtendWith(MockitoExtension.class)
class SummaryTemplateServiceTest {

    @Mock private AiClient ai;

    private static final List<AiClient.SummaryTemplateSummary> TEMPLATES = List.of(
            new AiClient.SummaryTemplateSummary("general", "General", List.of("Overview", "Outline")),
            new AiClient.SummaryTemplateSummary("executive", "Executive", List.of("Overview", "Asks")));

    @Test
    @DisplayName("the list is fetched once and then served from cache")
    void listIsCached() {
        when(ai.listTemplates()).thenReturn(TEMPLATES);
        SummaryTemplateService service = new SummaryTemplateService(ai);

        assertThat(service.list()).hasSize(2);
        assertThat(service.list()).hasSize(2);
        assertThat(service.list()).hasSize(2);

        verify(ai, times(1)).listTemplates();
    }

    @Test
    @DisplayName("a stale list is served when the ai-service is unreachable")
    void staleListSurvivesAnOutage() {
        when(ai.listTemplates())
                .thenReturn(TEMPLATES)
                .thenThrow(new RuntimeException("connection refused"));
        // Zero TTL so the second call really does re-fetch — with the normal
        // ten minutes this test would pass by never reaching the failure.
        SummaryTemplateService service = new SummaryTemplateService(ai, Duration.ZERO);

        assertThat(service.list()).hasSize(2);
        assertThat(service.list()).hasSize(2);
        verify(ai, times(2)).listTemplates();
    }

    @Test
    @DisplayName("an empty response does not overwrite a good cached list")
    void emptyResponseDoesNotPoisonTheCache() {
        when(ai.listTemplates()).thenReturn(TEMPLATES).thenReturn(List.of());
        SummaryTemplateService service = new SummaryTemplateService(ai, Duration.ZERO);

        assertThat(service.list()).hasSize(2);
        assertThat(service.list()).hasSize(2);
        verify(ai, times(2)).listTemplates();
    }

    // --- validation --------------------------------------------------------- //

    @Test
    @DisplayName("a blank slug means the default rather than an error")
    void blankMeansDefault() {
        SummaryTemplateService service = new SummaryTemplateService(ai);
        assertThat(service.requireKnown(null)).isEqualTo("general");
        assertThat(service.requireKnown("  ")).isEqualTo("general");
    }

    @Test
    @DisplayName("a known slug is accepted and trimmed")
    void knownSlugIsAccepted() {
        when(ai.listTemplates()).thenReturn(TEMPLATES);
        SummaryTemplateService service = new SummaryTemplateService(ai);
        assertThat(service.requireKnown(" executive ")).isEqualTo("executive");
    }

    @Test
    @DisplayName("an unknown slug is refused rather than quietly summarized as General")
    void unknownSlugIsRefused() {
        when(ai.listTemplates()).thenReturn(TEMPLATES);
        SummaryTemplateService service = new SummaryTemplateService(ai);

        // The ai-service would fall back to General for this. Doing so silently
        // would hand the user notes in a shape they did not ask for, with
        // nothing on the page to explain why — an error is the kinder outcome.
        assertThatThrownBy(() -> service.requireKnown("candidate-intervew"))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("candidate-intervew");
    }

    @Test
    @DisplayName("with no list available any slug is passed through")
    void unvalidatableSlugIsPassedThrough() {
        // Cold start plus an ai-service outage. Blocking the request would fail
        // a meeting over a validation we cannot perform; the ai-service is the
        // authority and resolves it on arrival.
        when(ai.listTemplates()).thenThrow(new RuntimeException("connection refused"));
        SummaryTemplateService service = new SummaryTemplateService(ai);

        assertThat(service.requireKnown("executive")).isEqualTo("executive");
    }
}
