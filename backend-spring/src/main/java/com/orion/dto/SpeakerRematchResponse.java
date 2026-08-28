package com.orion.dto;

import java.util.List;

/**
 * What happened when the user pressed "Rematch speakers".
 *
 * <p>Three outcomes, and they are three because collapsing any two of them
 * produces a screen that lies:
 *
 * <ul>
 *   <li><b>Somebody was matched.</b> {@code matched} is greater than zero and
 *       {@code names} says who. The count is the number of speakers renamed,
 *       not the number of turns, because "2 speakers rematched" is what the
 *       user did and "47 turns updated" is what the database did.
 *   <li><b>Nothing matched.</b> {@code matched} is zero and
 *       {@code unavailable} is null. This is the ordinary, common, correct
 *       outcome: the meeting had unresolved speakers, they were compared
 *       against every known voice, and none of them cleared the bar. Nothing
 *       is wrong and nothing needs fixing.
 *   <li><b>It could not run.</b> {@code unavailable} carries the reason —
 *       speaker matching switched off, not configured on this server, no
 *       recording left to analyse. Distinct from the case above because the
 *       user's next action differs completely: one of them is "there is a
 *       setting to turn on", the other is "there is nothing to do".
 * </ul>
 *
 * <p><b>No confidence figure is returned.</b> The matcher works on cosine
 * similarity between voice embeddings, which is the right quantity to threshold
 * on and is not a calibrated probability — 0.71 does not mean "71% sure this is
 * Sarah". Rendering it as a percentage would manufacture a precision the
 * matcher does not have, and would invite a user to accept a 68% match as a
 * near-certainty. The similarity is logged and tested; the screen gets a count.
 */
public record SpeakerRematchResponse(
        /** How many speakers were renamed. Zero is a normal answer. */
        int matched,
        /** Who they turned out to be, in the order they were resolved. */
        List<String> names,
        /** How many speakers were still wearing a generated label when we looked. */
        int considered,
        /** Why nothing could be attempted at all, or null if it was attempted. */
        String unavailable
) {

    /** Ran, found nobody. */
    public static SpeakerRematchResponse none(int considered) {
        return new SpeakerRematchResponse(0, List.of(), considered, null);
    }

    /** Did not run. */
    public static SpeakerRematchResponse unavailable(String reason) {
        return new SpeakerRematchResponse(0, List.of(), 0, reason);
    }
}
