package com.recallix.dto;

import com.recallix.domain.VocabularyCategory;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** POST/PUT /api/v1/vocabulary — one boosting hint. */
public record VocabularyTermRequest(
        @NotBlank @Size(max = 120) String term,
        @NotNull VocabularyCategory category,
        /** Only meaningful for {@link VocabularyCategory#ACRONYM}; ignored otherwise. */
        @Size(max = 240) String expansion,
        Boolean active
) {
    public String trimmedTerm() {
        return term == null ? "" : term.trim();
    }

    public String expansionOrEmpty() {
        // An expansion on a keyword is not an error worth rejecting a request
        // for — it is simply not a thing that kind of term has, so it is dropped
        // rather than stored where nothing will ever read it.
        if (category != VocabularyCategory.ACRONYM || expansion == null) {
            return "";
        }
        return expansion.trim();
    }

    public boolean activeOrDefault() {
        return active == null || active;
    }
}
