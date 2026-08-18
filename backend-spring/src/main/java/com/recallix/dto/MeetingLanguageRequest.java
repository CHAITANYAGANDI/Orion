package com.recallix.dto;

/**
 * POST /api/v1/meetings/{id}/language — what language this meeting is in.
 *
 * <p>Not part of {@link MeetingUpdateRequest}, which is metadata: a title or a
 * tag changes a label, and this re-transcribes an hour of audio and replaces
 * every word of the result. Folding it into the general PATCH would make
 * "rename this meeting" and "throw away this transcript and make a new one" the
 * same request, distinguishable only by which field happened to be non-null.
 *
 * <p>Blank or absent clears the override, handing the meeting back to the
 * account default — which is how somebody undoes a wrong answer without having
 * to go and read what their account setting says.
 */
public record MeetingLanguageRequest(String language) {
}
