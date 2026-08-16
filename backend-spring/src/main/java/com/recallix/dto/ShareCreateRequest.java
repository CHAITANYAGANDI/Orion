package com.recallix.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/**
 * What a share link should reveal, for how long, and to whom it should open.
 *
 * <p>Every field is optional. Omitted means "leave it as it is" on an existing
 * link and "use the default" on a new one — the defaults being summary and
 * action items yes, transcript and recording no, no password, no expiry.
 *
 * <p><b>Why removing a password needs its own flag.</b> The same problem as
 * unfiling a meeting from a project: an absent {@code password} and an explicit
 * empty one arrive identically, and one means "don't touch it" while the other
 * means "take it off". Conflating them would make a password impossible to
 * remove without deleting the link — and the link is the thing people have
 * already sent.
 */
public record ShareCreateRequest(
        Boolean includeSummary,
        Boolean includeActionItems,
        Boolean includeTranscript,
        Boolean includeAudio,

        @Min(1) @Max(365) Integer expiresInDays,
        /** Clears an expiry that was set, since a null date cannot say so. */
        Boolean neverExpires,

        @Size(min = 4, max = 200, message = "A share password must be at least 4 characters")
        String password,
        Boolean removePassword,

        @Size(max = 120) String label,

        /** Set together to share one excerpt rather than the whole meeting. */
        Double startSeconds,
        Double endSeconds,
        @Size(max = 5000) String quote
) {

    /** Whether this asks for a moment link. Both bounds or neither. */
    public boolean isMoment() {
        return startSeconds != null && endSeconds != null;
    }

    public boolean wantsPassword() {
        return password != null && !password.isBlank();
    }
}
