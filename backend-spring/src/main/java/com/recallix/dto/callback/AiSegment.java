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
        List<SpokenWord> words,
        /**
         * ISO-639-1 code, present only when the worker detected that this
         * utterance is in a different language from the meeting's. Absent from
         * an older worker's payload, and absent for every line of a monolingual
         * meeting — both of which mean the same thing here: nothing to mark.
         */
        String language
) {
    public List<SpokenWord> wordsOrEmpty() {
        return words == null ? List.of() : words;
    }
}
