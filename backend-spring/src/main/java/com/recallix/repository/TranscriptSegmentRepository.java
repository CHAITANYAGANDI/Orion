package com.recallix.repository;

import com.recallix.entity.TranscriptSegment;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface TranscriptSegmentRepository extends JpaRepository<TranscriptSegment, String> {
    List<TranscriptSegment> findByMeetingIdOrderByStartTimeAsc(String meetingId);
    void deleteByMeetingId(String meetingId);
}
