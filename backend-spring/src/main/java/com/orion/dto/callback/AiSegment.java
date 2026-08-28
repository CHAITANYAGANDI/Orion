package com.orion.dto.callback;

import com.orion.domain.SpokenWord;

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
        String language,
        /**
         * Meeting-local speaker identity ("spk_2"), assigned by the worker in
         * order of first appearance. Stable across renames, which is what
         * keeps a speaker's colour when they are given a real name. Null from
         * an older worker.
         */
        String speakerKey,
        /**
         * The provider's own cluster id ("A", "D") behind that label. Never
         * displayed. Kept because a renumbering bug is otherwise
         * undiagnosable after the fact.
         */
        String speakerRaw,
        /**
         * {@code attributed} or {@code unknown}. The worker already knew this
         * and it used to stop here, so a turn the provider refused to
         * attribute arrived looking exactly like a confident one.
         */
        String speakerStatus
) {
    /**
     * The shape before canonical speaker identity existed.
     *
     * <p>Kept so that a payload from an older worker — and the tests that
     * describe one — construct without naming three fields they have nothing
     * to put in. Identity is genuinely optional: a transcript without it
     * renders exactly as it did before, keyed on the display name.
     */
    public AiSegment(Double start, Double end, String speaker, String text,
                     List<SpokenWord> words, String language) {
        this(start, end, speaker, text, words, language, null, null, null);
    }

    public List<SpokenWord> wordsOrEmpty() {
        return words == null ? List.of() : words;
    }

    /** Defaulted rather than nullable: an older worker's segments are attributed. */
    public String speakerStatusOrDefault() {
        return speakerStatus == null || speakerStatus.isBlank() ? "attributed" : speakerStatus;
    }
}
