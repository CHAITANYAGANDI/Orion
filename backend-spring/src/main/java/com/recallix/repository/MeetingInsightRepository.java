package com.recallix.repository;

import com.recallix.entity.MeetingInsight;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface MeetingInsightRepository extends JpaRepository<MeetingInsight, String> {

    List<MeetingInsight> findByMeetingIdOrderByCreatedAt(String meetingId);

    /**
     * Drop only the rows a reprocess is entitled to replace.
     *
     * <p>Rows a human edited or added are kept. Re-running the pipeline
     * regenerates the derived decisions, and wiping the corrections alongside
     * them would mean the same wrong decision comes back every time somebody
     * fixes it — which teaches people not to bother fixing anything.
     */
    @Modifying
    @Query("DELETE FROM MeetingInsight i WHERE i.meetingId = :meetingId AND i.edited = false")
    void deleteDerivedByMeetingId(@Param("meetingId") String meetingId);
}
