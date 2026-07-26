package com.recallix.repository;

import com.recallix.entity.MeetingShare;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface MeetingShareRepository extends JpaRepository<MeetingShare, String> {

    Optional<MeetingShare> findByToken(String token);

    /** The single live link for a meeting, if one exists. */
    Optional<MeetingShare> findByMeetingIdAndRevokedFalse(String meetingId);
}
