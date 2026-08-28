package com.orion.domain;

/**
 * Which chat a conversation belongs to: one meeting, one project, or the whole
 * workspace.
 *
 * <p><b>Why this exists rather than a nullable meeting id.</b> Two scopes fitted
 * into one nullable column — set means a meeting, null means everything — and
 * that worked exactly until there was a third. Left as it was, "the workspace"
 * and "a project" would both be a null meeting id, so clearing the workspace
 * chat would delete every project's threads along with it, and the workspace
 * history picker would list them.
 *
 * <p>Making the scope a value forces every query to say which of the three it
 * means. The mutual exclusion is also a database constraint (V30), because a row
 * carrying both would be read as a meeting thread by one query and a project
 * thread by another.
 */
public record ChatScope(String meetingId, String projectId) {

    public static final ChatScope WORKSPACE = new ChatScope(null, null);

    public ChatScope {
        if (meetingId != null && projectId != null) {
            throw new IllegalArgumentException("A conversation belongs to one scope");
        }
    }

    /** A null id is the workspace — the shape the two-scope API already had. */
    public static ChatScope meeting(String meetingId) {
        return meetingId == null ? WORKSPACE : new ChatScope(meetingId, null);
    }

    public static ChatScope project(String projectId) {
        return projectId == null ? WORKSPACE : new ChatScope(null, projectId);
    }

    public boolean isWorkspace() {
        return meetingId == null && projectId == null;
    }

    public boolean isMeeting() {
        return meetingId != null;
    }

    public boolean isProject() {
        return projectId != null;
    }

    /** Whether a conversation belongs to this scope. */
    public boolean holds(String conversationMeetingId, String conversationProjectId) {
        return java.util.Objects.equals(meetingId, conversationMeetingId)
                && java.util.Objects.equals(projectId, conversationProjectId);
    }
}
