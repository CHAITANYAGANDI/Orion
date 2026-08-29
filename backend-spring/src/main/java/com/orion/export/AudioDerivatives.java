package com.orion.export;

import java.util.Locale;

/**
 * Where a converted copy of a recording lives, and whether one is needed.
 *
 * <h2>The key is the state</h2>
 *
 * <p>An MP3 export could have been a column: {@code mp3_object_key},
 * {@code mp3_state}, {@code mp3_failed_at}. It is not, and the reason is worth
 * writing down rather than rediscovering.
 *
 * <p>A derivative key computed from the source key means the object store
 * <em>is</em> the record. "Has this meeting been converted?" is one HEAD request
 * and it cannot disagree with the bucket — where a column can, in both
 * directions: a row saying "converted" over an object a lifecycle rule swept, or
 * a row saying nothing over an object a crashed worker had already written.
 * Every one of those states needs reconciling code, and reconciling code is only
 * exercised when something has already gone wrong.
 *
 * <p>It also makes deletion answerable. Erasure knows a meeting's object key;
 * from that it knows every object Orion holds for that recording, without a
 * join and without a migration that would have to backfill one. The privacy
 * flows must never miss a copy, and the way to guarantee that is for there to be
 * nowhere for a copy to hide.
 *
 * <p>The cost is that two workers converting the same meeting at the same moment
 * both write the same key. They write the same bytes, and an S3 PUT is atomic,
 * so the outcome is correct and merely wasteful — which is the right trade
 * against a distributed lock and a schema. The ai-service holds an in-process
 * guard that removes the waste for the case that actually happens: one person
 * clicking twice.
 *
 * <h2>Why the suffix, and not a separate prefix</h2>
 *
 * <p>{@code …/recording.webm.mp3} sits beside {@code …/recording.webm}, inside
 * the meeting's own prefix. So a bucket lifecycle rule, a manual sweep, or
 * anything else scoped to {@code meetings/{user}/{meeting}/} covers the
 * derivative too — automatically, including rules written before this feature
 * existed. A {@code derived/} prefix somewhere else would be a second place to
 * remember, and the history of data deletion is a history of second places
 * nobody remembered.
 */
public final class AudioDerivatives {

    private AudioDerivatives() {
    }

    /**
     * Whether the stored recording is already an MP3, in which case exporting
     * one is a presign and not a conversion.
     *
     * <p>Declared content type first, because that is what the uploader said the
     * bytes were. Older meetings and imports have none, so the key's extension
     * is the fallback — the same order {@code ExportService.mediaExtension}
     * uses, and it has to stay the same order: the two disagreeing would name a
     * file {@code .mp3} and convert it anyway, or worse, not convert it and
     * still name it {@code .mp3}.
     */
    public static boolean isMp3(String contentType, String objectKey) {
        String type = contentType == null
                ? "" : contentType.toLowerCase(Locale.ROOT).split(";")[0].trim();
        if (!type.isEmpty()) {
            return type.equals("audio/mpeg") || type.equals("audio/mp3");
        }
        return objectKey != null && objectKey.toLowerCase(Locale.ROOT).endsWith(".mp3");
    }

    /**
     * The key the converted copy is written to.
     *
     * @return null when there is no source to derive from, which the caller must
     *         treat as "there is nothing to delete and nothing to convert"
     */
    public static String mp3Key(String objectKey) {
        if (objectKey == null || objectKey.isBlank()) {
            return null;
        }
        return objectKey + ".mp3";
    }
}
