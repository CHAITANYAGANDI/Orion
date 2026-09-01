package com.reverie.domain;

/**
 * Where a meeting's content came from.
 *
 * <p>Only {@link #AUDIO} can be created now. Reverie transcribes recordings:
 * a YouTube link was somebody else's video and a PDF was a document nobody
 * attended, and both forced every feature downstream — speakers, timestamps,
 * playback, moments — to special-case a meeting that had none of them.
 *
 * <p>{@link #YOUTUBE} and {@link #DOCUMENT} remain because rows carrying them
 * remain. Deleting a constant does not delete the data that references it; it
 * turns those meetings into rows the application cannot read, which is a worse
 * outcome for their owner than a source type nothing produces any more.
 */
public enum SourceType {
    AUDIO,
    YOUTUBE,
    DOCUMENT
}
