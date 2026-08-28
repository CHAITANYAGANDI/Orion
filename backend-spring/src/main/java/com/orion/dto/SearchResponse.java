package com.orion.dto;

import java.time.Instant;
import java.util.List;

/**
 * One search, answered across everything a workspace holds.
 *
 * <p><b>Why the groups are typed fields and not a map.</b> A
 * {@code Map<String, Group>} would be shorter here and worse everywhere else:
 * the five groups hold genuinely different rows — a meeting has a status, a
 * person has a mention count, an utterance has a timestamp to seek to — so a map
 * would either erase those differences behind {@code Object} or force the client
 * to cast by key. Named fields give the frontend the shape of each row for free.
 *
 * <p><b>Why every group carries its own total.</b> The counts are the interface:
 * "27 transcript mentions" is what tells someone the answer is in the recording
 * rather than the title, and it has to be right even though only the first few
 * rows are sent. Each query therefore counts its full result set and returns a
 * page of it, so a total never means "as many as we bothered to fetch".
 *
 * <p>The hit shapes are nested rather than filed separately because they exist
 * only as rows of this response — none of them is returned by any other
 * endpoint, and five more files in {@code dto} would suggest otherwise.
 */
public record SearchResponse(
        String query,
        SearchGroup<MeetingHit> meetings,
        SearchGroup<PersonHit> people,
        SearchGroup<InsightHit> decisions,
        SearchGroup<InsightHit> risks,
        SearchGroup<CommitmentHit> commitments,
        SearchGroup<MentionHit> mentions
) {

    /** A page of one kind of result, plus how many there are in total. */
    public record SearchGroup<T>(long total, List<T> hits) {
        public static <T> SearchGroup<T> empty() {
            return new SearchGroup<>(0, List.of());
        }
    }

    /**
     * A meeting that matches.
     *
     * <p>{@code mentions} is how many of its utterances contain the term, and
     * {@code titleMatch} whether the name itself does. Both are shown: "Q3
     * Planning · 4 mentions" answers "why is this in my results" without the
     * user having to open it, which is the difference between a result list and
     * a list of guesses.
     */
    public record MeetingHit(
            String id,
            String title,
            String status,
            Instant createdAt,
            Integer durationSeconds,
            List<String> tags,
            String summaryTemplate,
            long mentions,
            boolean titleMatch
    ) {
    }

    /**
     * Someone who appears in the archive.
     *
     * <p>Not a user account — Orion has one of those per workspace. It is a
     * name that spoke, owns a commitment, or has been applied to a speaker
     * before, counted three ways that mean different things: {@code segments} is
     * how much they said, {@code mentions} how often anybody said their name,
     * and {@code commitments} how much they owe. Someone can score high on the
     * last two having attended nothing.
     */
    public record PersonHit(
            String name,
            long meetings,
            long segments,
            long mentions,
            long commitments
    ) {
    }

    /** A decision the meeting settled, or a risk it named. Same store, see V24. */
    public record InsightHit(
            String id,
            String meetingId,
            String meetingTitle,
            Instant meetingCreatedAt,
            String kind,
            String text
    ) {
    }

    /**
     * A commitment somebody made.
     *
     * <p>These are action items. Orion has no separate commitment store, and
     * deliberately so: the ai-service excludes a template's "Commitments"
     * section from the insight pass precisely because counting it there would
     * record every promise twice — once in the tracker that knows whether it was
     * done, and once in a list that does not. Searching them means searching the
     * tracker.
     */
    public record CommitmentHit(
            String id,
            String meetingId,
            String meetingTitle,
            Instant meetingCreatedAt,
            String title,
            String owner,
            String status,
            String dueDate
    ) {
    }

    /**
     * One utterance containing the term.
     *
     * <p>{@code start} is what makes this worth returning at all: a mention the
     * reader cannot jump to is just an assertion that the recording says
     * something somewhere.
     */
    public record MentionHit(
            String segmentId,
            String meetingId,
            String meetingTitle,
            Instant meetingCreatedAt,
            String speaker,
            Double start,
            String text
    ) {
    }
}
