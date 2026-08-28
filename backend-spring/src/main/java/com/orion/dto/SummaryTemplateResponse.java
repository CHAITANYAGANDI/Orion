package com.orion.dto;

import java.util.List;

/**
 * One template in the picker.
 *
 * <p>{@code sectionTitles} is what makes the choice meaningful: a name alone
 * does not tell anyone what "BANT" will produce, whereas the headings do.
 * The section <em>instructions</em> are not exposed — they are prompt wording,
 * not product, and they belong to the ai-service.
 */
public record SummaryTemplateResponse(
        String slug,
        String name,
        List<String> sectionTitles
) {
}
