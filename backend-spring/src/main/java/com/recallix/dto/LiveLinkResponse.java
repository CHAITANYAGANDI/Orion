package com.recallix.dto;

import com.recallix.entity.MeetingShare;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * One live share link, seen from the privacy page rather than from its meeting.
 *
 * <p>Deliberately not {@link ShareResponse}. That one is the editing view: it
 * carries the token so the dialog can build a URL, and four separate booleans
 * because there are four checkboxes beside it. This one answers a different
 * question — "what of mine is readable by anyone holding a URL right now" — and
 * the answer is a sentence, not a form. So the booleans arrive already collapsed
 * into a list a person can read, and the meeting's name is included, because on
 * this page the link is the row and the meeting is the detail.
 *
 * <p>The token is here too, because the only useful thing to do with a link you
 * have found on this page and did not expect is open it and see what it shows.
 */
public record LiveLinkResponse(
        String id,
        String meetingId,
        String meetingTitle,
        String url,
        String label,
        /** What this link reveals, in the order a reader meets it. */
        List<String> reveals,
        /** True for an excerpt link, which shows a clipped range rather than the meeting. */
        boolean moment,
        boolean passwordProtected,
        Instant expiresAt,
        int viewCount,
        Instant lastViewedAt,
        Instant createdAt
) {
    public static LiveLinkResponse from(MeetingShare share, String meetingTitle, String baseUrl) {
        List<String> reveals = new ArrayList<>();
        if (share.isIncludeSummary()) {
            reveals.add("summary");
        }
        if (share.isIncludeActionItems()) {
            reveals.add("action items");
        }
        if (share.isIncludeTranscript()) {
            reveals.add("transcript");
        }
        if (share.isIncludeAudio()) {
            reveals.add("recording");
        }
        // A link that reveals nothing is possible — every box unticked — and is
        // worth naming rather than showing as an empty row, because it looks
        // like a bug from the outside and is in fact a harmless link.
        if (reveals.isEmpty()) {
            reveals.add("the title only");
        }
        return new LiveLinkResponse(
                share.getId(),
                share.getMeetingId(),
                meetingTitle == null ? "Deleted meeting" : meetingTitle,
                baseUrl + "/shared/" + share.getToken(),
                share.getLabel(),
                reveals,
                share.isMoment(),
                share.isPasswordProtected(),
                share.getExpiresAt(),
                share.getViewCount(),
                share.getLastViewedAt(),
                share.getCreatedAt());
    }
}
