package com.recallix.dto;

import java.time.Instant;
import java.util.List;

/**
 * Everything the privacy page needs, in one request.
 *
 * <p>Four sections that are usually four features and are one page here, because
 * the questions behind them are asked together: what do you have of mine, who
 * else can see it, how long will you keep it, and how do I get it back or make
 * it stop. Splitting that into four endpoints would mean four loading states on
 * a page somebody opened because they were already uneasy.
 *
 * <p>{@code storage} is measured rather than asserted — see
 * {@link StorageFacts}.
 */
public record PrivacyOverviewResponse(
        Held held,
        Retention retention,
        StorageFacts storage,
        SignIn signIn
) {

    /**
     * How the caller got in, and whether a second factor was involved.
     *
     * <p>On the same response as the rest for the reason in the class comment:
     * "is my account protected" is asked in the same breath as "who can see my
     * meetings", and a second endpoint would be a second loading state on a page
     * somebody opened because they were already uneasy.
     *
     * @param mode            {@code clerk} or {@code dev}
     * @param managedExternally whether sign-in belongs to a provider, which is
     *                          also where a second factor is switched on
     * @param secondFactor    what the credential asserted, or null if it said
     *                        nothing — see {@code SignInSecurity} on why that is
     *                        not the same as false
     */
    public record SignIn(
            String mode,
            boolean managedExternally,
            Boolean secondFactor
    ) {
    }

    /**
     * What is actually stored, counted.
     *
     * <p>No byte totals. Getting them means a HEAD request per object, which
     * turns opening this page into one round trip per meeting somebody has ever
     * uploaded — and the honest number people want here is "how many recordings
     * of me do you have", not how many megabytes that came to.
     *
     * @param recordings meetings that still have their audio
     * @param audioErased meetings whose audio has been erased
     * @param transcriptsErased meetings whose transcript has been erased
     * @param consentConfirmed meetings whose recorder confirmed the room had
     *                         been told — only ever set by the browser recorder,
     *                         since an uploaded file was captured somewhere
     *                         Recallix was not present to ask
     */
    public record Held(
            long meetings,
            long recordings,
            long audioErased,
            long transcripts,
            long transcriptsErased,
            long actionItems,
            long marks,
            long projects,
            long chats,
            long consentConfirmed,
            Instant oldestMeetingAt
    ) {
    }

    /**
     * The two dials, and what they would delete tonight if they ran now.
     *
     * @param audioDays   null means recordings are kept
     * @param meetingDays null means meetings are kept
     */
    public record Retention(
            Integer audioDays,
            Integer meetingDays,
            int recordingsDueNow,
            int meetingsDueNow
    ) {
    }

    /**
     * How the recordings are stored, reported rather than claimed.
     *
     * <p>Three of these are properties of the code and are therefore always
     * true: the bucket is never public, every read is a URL we sign, and those
     * URLs expire. The fourth is a property of the deployment, and this is the
     * one worth being careful about — "encrypted storage" is the easiest claim
     * in the industry to make and the easiest to get wrong, because the setting
     * lives on the bucket and the bucket belongs to whoever runs the servers. So
     * {@code encryptionAtRest} is read back from the object store, and is null
     * when it says none is configured. A privacy page that prints a reassuring
     * sentence its own infrastructure would contradict is worse than one that
     * says nothing.
     */
    public record StorageFacts(
            String encryptionAtRest,
            long signedUrlSeconds,
            boolean rowLevelSecurity
    ) {
    }
}
