package com.recallix.domain;

/**
 * Where a meeting's content came from.
 *
 * <p>{@link #AUDIO} and {@link #YOUTUBE} both end up as audio bytes and are
 * transcribed. {@link #DOCUMENT} is already text, so it skips transcription —
 * which also means it has no audio player, no segments, and no transcript
 * deep-links.
 */
public enum SourceType {
    AUDIO,
    YOUTUBE,
    DOCUMENT
}
