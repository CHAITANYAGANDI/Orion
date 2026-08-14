package com.recallix.dto.callback;

/**
 * A decision or risk the worker read out of the summary it just wrote.
 *
 * <p>Not a second extraction pass: {@code sourceSection} names the summary
 * section these words came from, which is what guarantees the store and the
 * notes say the same thing.
 */
public record AiInsight(String kind, String text, String sourceSection) {

    /** True for a payload we can persist — an older worker sends neither field. */
    public boolean isUsable() {
        return text != null && !text.isBlank()
                && ("DECISION".equals(kind) || "RISK".equals(kind));
    }
}
