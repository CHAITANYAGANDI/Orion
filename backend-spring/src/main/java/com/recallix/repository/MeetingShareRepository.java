package com.recallix.repository;

import com.recallix.entity.MeetingShare;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface MeetingShareRepository extends JpaRepository<MeetingShare, String> {

    Optional<MeetingShare> findByToken(String token);

    /**
     * The meeting's own link — the one that shows the whole thing.
     *
     * <p>At most one can be live at a time (V31's partial unique index), which is
     * what keeps "Share" idempotent: pressing it twice must not mint a second URL
     * the owner never sees again and therefore cannot revoke.
     */
    Optional<MeetingShare> findFirstByMeetingIdAndRevokedFalseAndStartSecondsIsNull(String meetingId);

    /**
     * Every live link for a meeting, moment links included.
     *
     * <p>Moment links are deliberately not unique — sharing three excerpts with
     * three people is the point — so the dialog lists them and each is revoked on
     * its own.
     */
    List<MeetingShare> findByMeetingIdAndRevokedFalseOrderByCreatedAtDesc(String meetingId);

    Optional<MeetingShare> findByIdAndUserId(String id, String userId);

    /**
     * Every live link in the workspace, newest first.
     *
     * <p>The one question the per-meeting dialog cannot answer: what is public
     * right now. Somebody who has shared thirty meetings over a year is not
     * going to open thirty pages to find out.
     */
    List<MeetingShare> findByUserIdAndRevokedFalseOrderByCreatedAtDesc(String userId);
}
