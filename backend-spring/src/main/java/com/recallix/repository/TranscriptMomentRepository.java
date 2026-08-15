package com.recallix.repository;

import com.recallix.entity.TranscriptMoment;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

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
}
