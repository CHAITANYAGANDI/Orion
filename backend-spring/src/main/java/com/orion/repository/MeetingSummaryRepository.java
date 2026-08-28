package com.orion.repository;

import com.orion.entity.MeetingSummary;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface MeetingSummaryRepository extends JpaRepository<MeetingSummary, String> {
    Optional<MeetingSummary> findFirstByMeetingIdOrderByCreatedAtDesc(String meetingId);
    void deleteByMeetingId(String meetingId);
}
