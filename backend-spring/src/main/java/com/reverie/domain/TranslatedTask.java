package com.reverie.domain;

/**
 * One action item rendered in another language.
 *
 * <p>{@code sourceTitle} is the wording the translation was made from, kept so
 * the pairing can be checked rather than assumed. Tasks are the one part of a
 * meeting people edit after the fact — retitling a vague extraction is the
 * commonest edit there is — and when that happens the translation beside it
 * becomes a translation of a sentence that no longer exists. Comparing the two
 * lets the reader be shown the current wording instead, untranslated and
 * obviously so.
 *
 * <p>Only the text is stored. Status and the deadline are read from
 * the live task, so a translated view cannot disagree with the tracker about
 * what is still open.
 */
public record TranslatedTask(
        String id,
        String sourceTitle,
        String title,
        String ownerName,
        /** The spoken deadline translated; the resolved date needs no translating. */
        String dueDate
) {
}
