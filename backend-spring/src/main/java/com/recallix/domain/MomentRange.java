package com.recallix.domain;

/**
 * One meeting-transcript segment's share of a marked passage.
 *
 * <p>A selection that crosses an utterance boundary produces several of these —
 * common, because diarization splits on pauses rather than on sentences, so a
 * single spoken sentence often arrives as two segments.
 *
 * <p>Carries two anchors on purpose. The offsets are exact and cheap while the
 * line is untouched; {@code quote} is what lets the passage be found again
 * after somebody corrects a typo earlier in the same line, which shifts every
 * offset after it. Neither is trusted blindly: see the reader in
 * {@code frontend/lib/moments.ts}, which prefers the offsets, falls back to
 * searching for the quote, and gives up visibly rather than drawing a highlight
 * over words that were never selected.
 *
 * <p>Persisted as JSONB on the moment and returned over the API unchanged, so
 * like {@link SpokenWord} it lives in {@code domain} rather than being split
 * into a stored form and a wire form that could drift.
 */
public record MomentRange(
        String segmentId,
        int startOffset,
        int endOffset,
        String quote
) {
}
