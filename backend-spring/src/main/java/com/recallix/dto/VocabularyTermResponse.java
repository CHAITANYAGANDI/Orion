package com.recallix.dto;

import com.recallix.domain.VocabularyCategory;
import com.recallix.entity.VocabularyTerm;

import java.time.Instant;

public record VocabularyTermResponse(
        String id,
        String term,
        VocabularyCategory category,
        String expansion,
        boolean active,
        Instant createdAt
) {
    public static VocabularyTermResponse from(VocabularyTerm term) {
        return new VocabularyTermResponse(
                term.getId(),
                term.getTerm(),
                term.getCategory(),
                term.getExpansion(),
                term.isActive(),
                term.getCreatedAt());
    }
}
