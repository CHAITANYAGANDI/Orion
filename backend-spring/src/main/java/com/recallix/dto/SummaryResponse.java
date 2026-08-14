package com.recallix.dto;

import com.recallix.domain.Quotation;
import com.recallix.domain.SummarySection;

import java.util.List;

/**
 * A meeting's summary.
 *
 * <p>{@code sections} is the template-shaped form the UI renders. The three
 * flat fields below it are kept and still populated because the markdown
 * export, the public share page and the recap email all read them and should
 * not have to know which template ran — and because summaries written before
 * templates existed have nothing else.
 */
public record SummaryResponse(
        String meetingId,
        String shortSummary,
        String detailedSummary,
        List<String> keyPoints,
        List<SummarySection> sections,
        /**
         * Verified quotations, each with the moment it was said so the UI can
         * play from it. Empty for summaries generated before V22.
         */
        List<Quotation> quotes,
        String templateSlug,
        /**
         * True when the transcript has been edited since this summary was
         * written, so the notes and the transcript no longer agree.
         *
         * <p>The summary is not regenerated automatically — one model call per
         * typo fix is not a trade worth making — so this is what turns "the
         * summary is out of date" from something only the system knows into
         * something the reader can see and act on.
         */
        boolean stale
) {
}
