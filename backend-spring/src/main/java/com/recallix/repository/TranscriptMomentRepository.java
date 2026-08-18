package com.recallix.repository;

import com.recallix.entity.TranscriptMoment;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface TranscriptMomentRepository extends JpaRepository<TranscriptMoment, String> {

    /**
     * One meeting's moments in transcript order.
     *
     * <p>Ordered by position rather than by when they were made: the list sits
     * beside the transcript, and a reader scanning it is following the meeting,
     * not the marking session. Ties break on {@code createdAt} so two notes on
     * the same sentence keep a stable order instead of shuffling between
     * requests.
     */
    List<TranscriptMoment> findByMeetingIdOrderByStartSecondsAscCreatedAtAsc(String meetingId);

    long countByMeetingId(String meetingId);

    /**
     * The reaction this click would duplicate, if there is one.
     *
     * <p>Reacting is a toggle in the UI, so the second click on the same emoji
     * deletes rather than adds. This covers the cases the UI cannot see: a
     * double-click that raced itself, and a second tab open on the same
     * meeting. Without it the insert hits {@code uq_transcript_moments_reaction}
     * and a user who tapped twice gets a 500 for a gesture that should be a
     * no-op.
     *
     * <p>Matched on the exact start time rather than a window, matching the
     * unique index: a reaction anchors to a turn, and two turns never share a
     * start.
     */
    Optional<TranscriptMoment> findFirstByMeetingIdAndUserIdAndKindAndStartSecondsAndBody(
            String meetingId, String userId, String kind, double startSeconds, String body);

    long countByUserId(String userId);

    /**
     * Erasing the transcript takes the marks with it.
     *
     * <p>A highlight is a quotation: it stores the words it was made on, so a
     * transcript deleted while its marks survive has not been deleted. The note
     * somebody typed against it goes too, for the same reason — it is only ever
     * read beside the sentence it is about.
     */
    void deleteByMeetingId(String meetingId);
}
