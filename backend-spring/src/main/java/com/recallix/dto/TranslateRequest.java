package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * POST /api/v1/meetings/{id}/translations
 *
 * <p>{@code targetLanguage} takes a code or a name — "es", "Spanish",
 * "Español" all resolve — and is refused with a 400 if it is none of the
 * supported eighteen. See {@link com.recallix.domain.Language}.
 *
 * <p>{@code includeTranscript} is opt-in and separate because it is the
 * expensive half by an order of magnitude: a brief is a few hundred words, an
 * hour of speech is several thousand across hundreds of utterances. Translating
 * it for somebody who only wanted to read the summary spends their money and
 * thirty seconds of their time on something they will not open.
 */
public record TranslateRequest(
        @NotBlank String targetLanguage,
        boolean includeTranscript
) {
}
