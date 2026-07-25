package com.recallix.repository;

import com.recallix.entity.MeetingDecision;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface MeetingDecisionRepository extends JpaRepository<MeetingDecision, String> {
    List<MeetingDecision> findByMeetingId(String meetingId);
    void deleteByMeetingId(String meetingId);
}
