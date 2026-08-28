package com.orion.domain;

import java.util.Set;

/**
 * What to put in an exported file, and how to lay the transcript out.
 *
 * <p>Everything here used to be one boolean — whether to append the transcript
 * — because the export was one file with one shape. It is now a set of choices
 * because people export for different reasons: a summary to paste into a reply,
 * a transcript to search, a plain wall of text to feed something else. Those
 * want different documents, and producing one document and asking the reader to
 * delete the parts they did not want is not an export.
 *
 * <p>The defaults are the old behaviour exactly — everything but the transcript
 * — so a caller that passes {@link #defaults()} gets the file it got before.
 *
 * @param summary       include the brief at all
 * @param sections      which summary sections, by key; empty means all of them
 * @param actionItems   include what people agreed to do
 * @param transcript    include every word, which is usually most of the file
 * @param speakerNames  label each utterance with who said it
 * @param timestamps    label each utterance with when it was said
 * @param combine       how much to merge consecutive utterances
 */
public record ExportOptions(
        boolean summary,
        Set<String> sections,
        boolean actionItems,
        boolean transcript,
        boolean speakerNames,
        boolean timestamps,
        Combine combine
) {

    /** How much of the back-and-forth to flatten away. */
    public enum Combine {
        /** One block per utterance, as spoken. */
        NONE,
        /**
         * Consecutive utterances by the same speaker become one block.
         * Diarisation splits a single person's turn at every pause, so a
         * monologue arrives as a dozen fragments; this puts it back together.
         */
        SAME_SPEAKER,
        /**
         * Everything becomes one block of prose. Loses who said what, which is
         * the point when the file is going somewhere that only wants the words.
         */
        ALL;

        public static Combine of(String raw) {
            if (raw == null) {
                return NONE;
            }
            return switch (raw.trim().toLowerCase()) {
                case "speaker", "same_speaker", "samespeaker" -> SAME_SPEAKER;
                case "all" -> ALL;
                default -> NONE;
            };
        }
    }

    public ExportOptions {
        sections = sections == null ? Set.of() : Set.copyOf(sections);
        combine = combine == null ? Combine.NONE : combine;
    }

    /** The summary, the tasks, and no transcript — what /export produced before. */
    public static ExportOptions defaults() {
        return new ExportOptions(true, Set.of(), true, false, true, true, Combine.NONE);
    }

    /** As {@link #defaults()} but with every word appended. */
    public static ExportOptions withTranscript(boolean include) {
        return new ExportOptions(true, Set.of(), true, include, true, true, Combine.NONE);
    }

    /**
     * Whether a section survives the filter.
     *
     * <p>An empty set means everything rather than nothing, which is the
     * opposite of what the collection literally says and the right reading of
     * what the caller meant: a request that names no sections is not a request
     * for an empty document.
     */
    public boolean wants(String sectionKey) {
        return sections.isEmpty() || sections.contains(sectionKey);
    }

    /** True when the request would produce a file with nothing in it. */
    public boolean empty() {
        return !summary && !actionItems && !transcript;
    }
}
