package com.reverie.domain;

/**
 * One transcript utterance in another language.
 *
 * <p>Words only, keyed by the segment they belong to. Speaker, start, end and
 * the word-level timings are deliberately absent: they are read from the live
 * segment at render time, so a translated transcript cannot drift from the
 * player or attribute a line to the wrong person. Renaming a speaker or
 * re-matching a voice therefore takes effect in every language at once, without
 * a single translation being rewritten.
 */
public record TranslatedLine(String id, String text) {
}
