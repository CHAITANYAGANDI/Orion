package com.orion.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.orion.entity.MeetingUsageCharge;
import com.orion.entity.MeetingUsageChargeId;

public interface MeetingUsageChargeRepository
        extends JpaRepository<MeetingUsageCharge, MeetingUsageChargeId> {

    /**
     * Record that this attempt has been billed, if nobody has already.
     *
     * <p>Deliberately a native {@code ON CONFLICT DO NOTHING} rather than
     * {@code existsById} followed by {@code save}. Two duplicate result
     * callbacks running at the same instant both pass an existence check —
     * neither can see the other's uncommitted row — and both then charge. The
     * primary key is the only thing that can arbitrate that, so the decision is
     * taken by the database and reported back as a row count.
     *
     * @return 1 when this call is the one that claimed the attempt, 0 when it
     *         was already claimed and the caller must not charge.
     */
    @Modifying
    @Query(value = """
            INSERT INTO meeting_usage_charges (meeting_id, attempt, user_id, minutes)
            VALUES (:meetingId, :attempt, :userId, :minutes)
            ON CONFLICT (meeting_id, attempt) DO NOTHING
            """, nativeQuery = true)
    int claim(@Param("meetingId") String meetingId,
              @Param("attempt") int attempt,
              @Param("userId") String userId,
              @Param("minutes") int minutes);
}
