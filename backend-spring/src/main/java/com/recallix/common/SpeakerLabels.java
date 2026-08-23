package com.recallix.common;

/**
 * Telling a placeholder speaker label apart from a person's name.
 *
 * <p>This one predicate is the guard on the whole of automatic speaker
 * identification. Everything a rematch is forbidden to overwrite — a name
 * somebody typed, a name an earlier rematch resolved — is protected by it, and
 * every label a rematch is allowed to touch is one it returns true for.
 *
 * <p>It matches the labels <b>Recallix itself generates</b> and nothing else:
 * "Speaker 1", "spk_2", "Unknown speaker". It is deliberately not a test for
 * "does this look like a real name", which is the clever version and the wrong
 * one: somebody who renames a speaker to "Facilitator", "Interviewer 2",
 * "The candidate" or "Speaker of the House" has made a decision about their own
 * transcript, and a heuristic that decided those were placeholders would spend
 * its time undoing users' work.
 *
 * <p>Mirrored in {@code ai-service/app/voiceprints.py:is_unresolved}. The two
 * are checked in both places on purpose — the ai-service decides what to
 * propose, and Spring decides what to apply, so the line between "a bad match"
 * and "overwrote a name a user typed" is defended on both sides of the wire.
 */
public final class SpeakerLabels {

    /**
     * An exact shape, not a prefix.
     *
     * <p>The difference is a bug a test caught before a user did: matching on
     * the prefix "speaker " also matches <b>"Speaker of the House"</b>, so a
     * rematch would have overwritten a name somebody deliberately typed. Only
     * the three forms Recallix generates count, and each must match end to end.
     */
    private static final java.util.regex.Pattern UNRESOLVED = java.util.regex.Pattern.compile(
            "^(speaker\\s+\\d+|spk_\\d+|unknown speaker)$",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    private SpeakerLabels() {
    }

    /**
     * Whether this label is still a placeholder rather than a person.
     *
     * <p>Null and blank are <b>not</b> unresolved. A turn with no speaker at all
     * is an unattributed one: the provider declined to say whose it was, and the
     * audio underneath it may be anybody's, so there is nothing there to
     * identify. Calling it unresolved would invite exactly the guess this whole
     * feature refuses to make.
     */
    public static boolean isUnresolved(String displayName) {
        if (displayName == null || displayName.isBlank()) {
            return false;
        }
        return UNRESOLVED.matcher(displayName.strip()).matches();
    }
}
