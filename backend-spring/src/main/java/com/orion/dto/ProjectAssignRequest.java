package com.orion.dto;

/**
 * Filing a meeting, or taking it out of a project.
 *
 * <p><b>Why this is not a field on {@code MeetingUpdateRequest}.</b> That
 * request leaves omitted fields alone, and Jackson cannot tell an omitted
 * {@code projectId} from one explicitly sent as {@code null} — both arrive as
 * null. Since "take this out of its project" is exactly the second case, folding
 * it in would make unfiling impossible to express. A request of its own has a
 * null with only one meaning.
 */
public record ProjectAssignRequest(String projectId) {

    /** Null, or blank from a form that submitted an empty select, means unfile. */
    public String targetOrNull() {
        return projectId == null || projectId.isBlank() ? null : projectId.trim();
    }
}
