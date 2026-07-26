package com.recallix.repository;

import com.recallix.entity.CommitmentEvidence;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface CommitmentEvidenceRepository extends JpaRepository<CommitmentEvidence, String> {

    List<CommitmentEvidence> findByCommitmentIdOrderByCreatedAtAsc(String commitmentId);

    List<CommitmentEvidence> findByCommitmentIdInOrderByCreatedAtAsc(List<String> commitmentIds);

    /** Used to make re-reconciling the same meeting overwrite rather than duplicate. */
    Optional<CommitmentEvidence> findByCommitmentIdAndMeetingId(String commitmentId, String meetingId);
}
