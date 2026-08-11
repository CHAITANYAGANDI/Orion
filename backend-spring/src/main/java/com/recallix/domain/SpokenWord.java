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
 */
public record SpokenWord(String text, double start, double end) {
}
