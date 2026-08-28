package com.orion.domain;

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
 * <p><b>They used to be called Express and Advanced.</b> Those named two
 * different axes: "Express" is a claim about speed and "Advanced" is a claim
 * about capability, so the pair read as fast-and-basic against slow-and-clever
 * and quietly told anybody in a hurry they were getting the worse answer. They
 * are not on that axis at all — both see the same complete records, and the
 * only difference is how much transcript is read around them. {@code Quick} and
 * {@code Thorough} are two ends of one axis, which is the true shape of the
 * choice.
 *
 * <p>{@link #QUICK} is the default and is precisely the behaviour that existed
 * before the choice did, so nothing regresses for a client that never sends the
 * field.
 */
public enum ChatMode {

    /** Balanced. The width the workspace chat has always used. */
    QUICK("express", "Quick", "Answers from the strongest evidence"),

    /** Wider retrieval and an enumerated answer. Costs more context and time. */
    THOROUGH("advanced", "Thorough", "Reads more of the conversation and lists what it finds");

    /**
     * What the ai-service expects on the wire, which is not the constant's name.
     *
     * <p>Pinned to the old words on purpose. `express` and `advanced` are spoken
     * by `rag.py`, `answering.py`, `retrieval.py` and their tests, and renaming
     * a protocol across two services to match a label somebody reads is churn
     * with an outage in it: the two deploy separately, so for the minutes
     * between them one of them is sending a word the other has never heard.
     * The label is what changed, because the label is what was wrong.
     */
    private final String wire;

    private final String label;
    private final String hint;

    ChatMode(String wire, String label, String hint) {
        this.wire = wire;
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
        return wire;
    }

    /**
     * Read a client's value, falling back to {@link #QUICK}.
     *
     * <p>Accepts the constant's name and the wire word, so `quick`, `QUICK`,
     * `express` and a stale tab still holding `advanced` all resolve. That is
     * not politeness: the client sends back whatever `/chat/modes` gave it, and
     * a page open across the rename is holding the previous answer.
     *
     * <p>Never throws. An unknown mode is a client sending a value from a newer
     * build, and answering the question with the safe default beats refusing to
     * answer it at all.
     */
    public static ChatMode of(String raw) {
        if (raw == null || raw.isBlank()) {
            return QUICK;
        }
        String value = raw.trim().toLowerCase(Locale.ROOT);
        for (ChatMode mode : values()) {
            if (mode.name().toLowerCase(Locale.ROOT).equals(value) || mode.wire.equals(value)) {
                return mode;
            }
        }
        return QUICK;
    }
}
