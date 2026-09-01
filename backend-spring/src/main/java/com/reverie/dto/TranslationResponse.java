package com.reverie.dto;

import com.reverie.domain.Language;
import com.reverie.domain.SummarySection;
import com.reverie.entity.MeetingTranslation;

import java.time.Instant;
import java.util.List;

/**
 * A meeting read in another language.
 *
 * <p>Shaped like the untranslated brief on purpose — same {@code sections},
 * same field names — so the page renders one component either way rather than a
 * second, thinner layout that appears only when somebody switches language.
 * That thinner layout was the old behaviour and it quietly showed less of the
 * meeting than English did.
 *
 * <p>Two things are absent and neither is an oversight. There are no
 * quotations: a quote claims to be the exact words somebody said, and a
 * translated quote is a paraphrase in quotation marks. And the transcript is
 * empty until it has been asked for, which {@code hasTranscript} says plainly
 * rather than leaving the reader to infer it from an empty list.
 */
public record TranslationResponse(
        String language,
        String languageName,
        boolean rightToLeft,

        String shortSummary,
        String detailedSummary,
        List<String> keyPoints,
        List<SummarySection> sections,
        List<TranslatedTaskResponse> actionItems,
        List<TranslatedSegmentResponse> segments,

        boolean hasBrief,
        boolean hasTranscript,
        /** The meeting changed after this was made; the UI offers a retranslate. */
        boolean stale,
        Instant briefTranslatedAt,
        Instant transcriptTranslatedAt
) {
    /**
     * A task in the reader's language, or in the original when it has moved on.
     *
     * <p>{@code translated} false means the wording changed after the
     * translation was made, so what is shown is the current English rather than
     * a translation of a sentence that has been replaced. Saying so is the
     * point: silently showing stale text is the failure, showing untranslated
     * text is merely visible.
     */
    public record TranslatedTaskResponse(
            String id,
            String title,
            String ownerName,
            String dueDate,
            boolean translated
    ) {
    }

    /** Words only — speaker and timings come from the live segment. */
    public record TranslatedSegmentResponse(String id, String text) {
    }

    public static TranslationResponse from(MeetingTranslation t,
                                           List<TranslatedTaskResponse> tasks,
                                           List<TranslatedSegmentResponse> segments) {
        Language language = Language.find(t.getLanguage()).orElse(Language.ENGLISH);
        return new TranslationResponse(
                t.getLanguage(),
                language.englishName(),
                language.rightToLeft(),
                t.getShortSummary(),
                t.getDetailedSummary(),
                t.getKeyPoints(),
                t.getSections(),
                tasks,
                segments,
                t.hasBrief(),
                t.hasTranscript(),
                t.isStale(),
                t.getBriefTranslatedAt(),
                t.getTranscriptTranslatedAt());
    }

    /** What languages a meeting has been translated into, for the picker. */
    public record Available(
            String language,
            String languageName,
            boolean hasTranscript,
            boolean stale,
            Instant updatedAt
    ) {
        public static Available from(MeetingTranslation t) {
            return new Available(
                    t.getLanguage(),
                    Language.label(t.getLanguage()),
                    t.hasTranscript(),
                    t.isStale(),
                    t.getUpdatedAt());
        }
    }
}
