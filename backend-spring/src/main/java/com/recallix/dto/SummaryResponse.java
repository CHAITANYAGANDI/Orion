package com.recallix.dto;

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
        String templateSlug
) {
}
