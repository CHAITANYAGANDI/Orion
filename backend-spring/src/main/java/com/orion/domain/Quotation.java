package com.orion.domain;

/**
 * One line reproduced exactly as it was spoken, with where to hear it.
 *
 * <p>Every quotation stored has already been matched back against the
 * transcript by the worker; the model's candidates never reach a reader
 * unchecked. {@code speaker} and {@code start} come from the segment the quote
 * was found in rather than from the model, which is what lets the UI play from
 * the moment it was said.
 *
 * <p>A record, and persisted as JSONB, for the same reason {@link SpokenWord}
 * is: these are only ever read as a whole summary's worth.
 */
public record Quotation(String text, String speaker, double start) {

    /** Jackson needs this when a stored entry predates a field being added. */
    public Quotation {
        text = text == null ? "" : text;
        speaker = speaker == null ? "" : speaker;
    }
}
