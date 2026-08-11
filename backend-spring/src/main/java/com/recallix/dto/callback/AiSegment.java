package com.recallix.dto.callback;

import com.recallix.domain.SpokenWord;

import java.util.List;

public record AiSegment(
        Double start,
        Double end,
        String speaker,
        String text,
        /**
         * Per-word timings. Absent when an older worker posts the result, or
         * when the provider gives none; the client falls back to estimating
         * from the segment span.
         */
        List<SpokenWord> words
) {
    public List<SpokenWord> wordsOrEmpty() {
        return words == null ? List.of() : words;
    }
}
