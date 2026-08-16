package com.recallix.dto;

import com.recallix.domain.Language;

/**
 * One language the product works in.
 *
 * <p>Served from the backend rather than hard-coded in the browser because the
 * same list bounds what audio can be transcribed and what a brief can be
 * translated into, and a second copy in TypeScript is a second copy that
 * eventually disagrees with the one doing the validating.
 */
public record LanguageResponse(
        /** ISO-639-1 — what everything downstream stores and compares. */
        String code,
        String name,
        /** The endonym: somebody scanning for their own language finds 日本語 faster. */
        String nativeName,
        /** Arabic and Hebrew. The translated panes set `dir` from this. */
        boolean rightToLeft
) {
    public static LanguageResponse from(Language language) {
        return new LanguageResponse(
                language.code(), language.englishName(), language.nativeName(), language.rightToLeft());
    }
}
