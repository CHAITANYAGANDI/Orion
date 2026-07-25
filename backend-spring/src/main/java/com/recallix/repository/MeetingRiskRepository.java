package com.recallix.repository;

import com.recallix.entity.MeetingRisk;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface MeetingRiskRepository extends JpaRepository<MeetingRisk, String> {
    List<MeetingRisk> findByMeetingId(String meetingId);
    void deleteByMeetingId(String meetingId);
}
