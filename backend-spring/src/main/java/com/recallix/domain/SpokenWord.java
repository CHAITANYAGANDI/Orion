package com.recallix.domain;

/**
 * One spoken word with its own timing, in seconds.
 *
 * <p>Persisted as JSONB on the segment and returned over the API unchanged, so
 * like {@link SummarySection} it lives in {@code domain} rather than being
 * split into a stored form and a wire form that could drift.
 *
 * <p>Exists because a word's position inside an utterance cannot be inferred
 * from the utterance's span. Speech pauses, so spreading a thirty-second turn
 * evenly across its text puts the highlight ahead of the voice — and makes
 * click-to-play land on the wrong sentence.
 *
 * <p>{@code speaker} and {@code speakerRaw} are the canonical label and the
 * provider's own cluster id. Diarization attributes per word, not only per
 * utterance, and discarding that was how a one-word interjection came to be
 * absorbed into the turn around it — there was nowhere for "somebody else said
 * this bit" to live. Both are null on words stored before V46 and on providers
 * that only attribute whole utterances; nothing requires them, and the
 * transcript renders identically without them.
 *
 * <p>Persisted inside {@code words_json}, so adding these needed no column.
 * Jackson leaves them null when reading a row written by the older shape.
 */
public record SpokenWord(String text, double start, double end, String speaker, String speakerRaw) {

    /** The timing-only form, for callers with no attribution to record. */
    public SpokenWord(String text, double start, double end) {
        this(text, start, end, null, null);
    }
}
