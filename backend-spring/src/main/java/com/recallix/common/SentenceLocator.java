package com.recallix.common;

import java.util.List;

/**
 * Finds where a quoted sentence was said.
 *
 * <p>An action item records the words the commitment was made in, which is most
 * of its value as evidence. The thing a reader wants next is to hear it, and
 * text cannot be seeked to — so the sentence has to be matched back to the
 * transcript segment it came from, once, when the brief is persisted.
 *
 * <p>The match is on normalised text rather than an exact string compare. The
 * extractor quotes a sentence out of a segment and is not obliged to reproduce
 * its punctuation or casing, and one segment can hold several sentences while
 * one sentence can run across two segments. Both directions of containment are
 * therefore tried.
 *
 * <p><strong>It returns null readily.</strong> A wrong timestamp is worse than
 * none: the link plays somebody saying something else, which reads as the
 * evidence being fabricated. Short sentences are not matched at all — "yes",
 * "sounds good" and "we should do that" appear all over a transcript, and the
 * first occurrence is not evidence of anything.
 */
public final class SentenceLocator {

    private SentenceLocator() {
    }

    /** One transcript line: when it starts, and what was said. */
    public record Line(Double start, String text) {
    }

    /**
     * Below this many characters of normalised text, a sentence is too common to
     * place. Roughly "let me look into that" — long enough that repetition is a
     * coincidence rather than the norm.
     */
    private static final int MIN_SENTENCE = 18;

    /**
     * When the segment is the shorter side, it has to be a substantial part of
     * the sentence to count. Otherwise a one-word line matches everything.
     */
    private static final double MIN_SEGMENT_SHARE = 0.5;

    /**
     * @return the start time of the earliest line the sentence can be placed in,
     *         or null when it cannot be placed with confidence
     */
    public static Double locate(String sentence, List<Line> lines) {
        if (sentence == null || lines == null || lines.isEmpty()) {
            return null;
        }
        String needle = normalise(sentence);
        if (needle.length() < MIN_SENTENCE) {
            return null;
        }

        // Two passes rather than one, because a segment that wholly contains the
        // quote is a better answer than a segment the quote merely overlaps, and
        // the better answer must win even when it appears later in the meeting.
        for (Line line : lines) {
            if (line.start() == null) {
                continue;
            }
            String hay = normalise(line.text());
            if (hay.contains(needle)) {
                return line.start();
            }
        }
        for (Line line : lines) {
            if (line.start() == null) {
                continue;
            }
            String hay = normalise(line.text());
            if (hay.length() >= MIN_SENTENCE
                    && hay.length() >= needle.length() * MIN_SEGMENT_SHARE
                    && needle.contains(hay)) {
                return line.start();
            }
        }
        return null;
    }

    /** Letters and digits only, single-spaced — punctuation and case carry no evidence. */
    private static String normalise(String text) {
        if (text == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder(text.length());
        boolean space = false;
        for (int i = 0; i < text.length(); i++) {
            char c = Character.toLowerCase(text.charAt(i));
            if (Character.isLetterOrDigit(c)) {
                sb.append(c);
                space = false;
            } else if (!space && sb.length() > 0) {
                sb.append(' ');
                space = true;
            }
        }
        return sb.toString().trim();
    }
}
