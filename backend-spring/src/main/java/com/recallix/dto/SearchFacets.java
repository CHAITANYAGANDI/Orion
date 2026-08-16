package com.recallix.dto;

import java.util.List;

/**
 * The values a filter can actually take in <em>this</em> workspace.
 *
 * <p>Filters that are free-text boxes are filters nobody uses: a speaker filter
 * only works if you spell the name the way the transcript spells it, and an
 * owner filter only works if you remember that the tracker says "Priya" and not
 * "Priya S.". Every list here is read from the user's own rows, so the filter
 * offers what is there and nothing that is not — an empty list means that filter
 * has nothing to narrow and the UI drops it rather than showing a dead control.
 *
 * <p>{@code types} holds summary-template slugs. That is what a "meeting type"
 * is in Recallix: the shape a meeting is summarised in — 1:1, standup,
 * interview — chosen per meeting and stored on it since V12. There is no second
 * type field, and inventing one would leave two answers to the same question.
 */
public record SearchFacets(
        List<String> speakers,
        List<String> tags,
        List<String> owners,
        List<String> types,
        List<String> statuses
) {
}
