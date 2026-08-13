package com.recallix.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * PATCH /api/v1/meetings/{id}/speakers/rematch — fix diarization, not naming.
 *
 * <p>Renaming answers "who is Speaker 2?". Rematching answers the two questions
 * a rename cannot:
 *
 * <ul>
 *   <li><b>Merge</b> ({@code fromSpeaker} set): diarization split one person
 *       across two labels, usually after a long pause or a change in mic level.
 *       Every turn labelled {@code fromSpeaker} becomes {@code toSpeaker}.
 *   <li><b>Reassign</b> ({@code segmentIds} set): individual turns were
 *       attributed to the wrong person, typically at a handover where two people
 *       overlap. Only those turns move.
 * </ul>
 *
 * <p>Exactly one of the two must be supplied — see
 * {@link #validate()}. Doing both in one request would make the result depend
 * on which was applied first.
 */
public record SpeakerRematchRequest(
        /** Merge source: the label being folded away. Null for a segment reassignment. */
        String fromSpeaker,
        /** Where the turns end up. Required in both modes. */
        @NotBlank @Size(max = 120) String toSpeaker,
        /** Segments to move. Null or empty for a whole-label merge. */
        List<String> segmentIds
) {

    public boolean isMerge() {
        return fromSpeaker != null && !fromSpeaker.isBlank();
    }

    public List<String> segmentIdsOrEmpty() {
        return segmentIds == null ? List.of() : segmentIds;
    }

    public String trimmedTo() {
        return toSpeaker == null ? "" : toSpeaker.trim();
    }

    /**
     * @return an error message when the request is not one of the two supported
     *         shapes, or null when it is.
     */
    public String validate() {
        boolean merge = isMerge();
        boolean reassign = !segmentIdsOrEmpty().isEmpty();
        if (merge == reassign) {
            return "Send either fromSpeaker (to merge a label) or segmentIds (to move turns), not both";
        }
        if (merge && fromSpeaker.trim().equals(trimmedTo())) {
            return "That speaker is already " + trimmedTo();
        }
        return null;
    }
}
