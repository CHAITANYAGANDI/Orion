package com.reverie.repository;

import com.reverie.entity.MeetingTranscript;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface MeetingTranscriptRepository extends JpaRepository<MeetingTranscript, String> {
    Optional<MeetingTranscript> findFirstByMeetingIdOrderByCreatedAtDesc(String meetingId);
    void deleteByMeetingId(String meetingId);
}
