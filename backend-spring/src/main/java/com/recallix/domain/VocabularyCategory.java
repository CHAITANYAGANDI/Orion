package com.recallix.domain;

/**
 * What kind of term the user added.
 *
 * <p>All four end up in the same boosting list on the transcription request —
 * the category is what the user is telling us, not a different mechanism. It is
 * kept because it lets the UI group the list, and because {@link #ACRONYM} is
 * the only kind that carries an expansion.
 */
public enum VocabularyCategory {
    /** A word or phrase that matters to this user's meetings. */
    KEYWORD,
    /** A person, product or company name the transcriber keeps mangling. */
    NAME,
    /** Domain or technical jargon. */
    JARGON,
    /** An acronym, optionally with what it stands for. */
    ACRONYM
}
