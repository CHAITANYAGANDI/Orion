package com.recallix.repository;

import com.recallix.entity.DecisionLink;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface DecisionLinkRepository extends JpaRepository<DecisionLink, String> {

    Optional<DecisionLink> findByIdAndUserId(String id, String userId);

    Optional<DecisionLink> findByEarlierDecisionIdAndLaterDecisionId(String earlierId, String laterId);

    List<DecisionLink> findByUserIdOrderByCreatedAtDesc(String userId);

    List<DecisionLink> findByUserIdAndAcknowledgedOrderByCreatedAtDesc(String userId, boolean acknowledged);

    long countByUserIdAndAcknowledgedAndRelation(String userId, boolean acknowledged, String relation);
}
