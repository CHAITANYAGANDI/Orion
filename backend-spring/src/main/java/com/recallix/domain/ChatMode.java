package com.recallix.domain;

import java.util.Locale;

/**
 * How hard the workspace chat should look before answering.
 *
 * <p>Two settings, differing in exactly two things so that neither is simply a
 * worse version of the other: how many passages retrieval returns, and whether
 * the answer is asked to enumerate rather than summarise. Everything else —
 * the complete commitment and decision ledgers that stop the model being
 * confidently wrong about what is outstanding — is in both, because withholding
 * a complete record from the cheaper mode would make it inaccurate rather than
 * merely shallower.
 *
 * <p>{@link #EXPRESS} is the default and is precisely the behaviour that
 * existed before the choice did, so nothing regresses for a client that never
 * sends the field.
 */
public enum ChatMode {

    /** Balanced. The width the workspace chat has always used. */
    EXPRESS("Express", "Balanced for accuracy and speed"),

    /** Wider retrieval and an enumerated answer. Costs more context and time. */
    ADVANCED("Advanced", "For in-depth analysis and actions");

    private final String label;
    private final String hint;

    ChatMode(String label, String hint) {
        this.label = label;
        this.hint = hint;
    }

    public String label() {
        return label;
    }

    /** The line under the name in the picker. */
    public String hint() {
        return hint;
    }

    /** What the ai-service expects on the wire. */
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }

    /**
     * Read a client's value, falling back to {@link #EXPRESS}.
     *
     * <p>Never throws. An unknown mode is a client sending a value from a newer
     * build, and answering the question with the safe default beats refusing to
     * answer it at all.
     */
    public static ChatMode of(String raw) {
        if (raw == null || raw.isBlank()) {
            return EXPRESS;
        }
        String value = raw.trim().toUpperCase(Locale.ROOT);
        for (ChatMode mode : values()) {
            if (mode.name().equals(value)) {
                return mode;
            }
        }
        return EXPRESS;
    }
}
