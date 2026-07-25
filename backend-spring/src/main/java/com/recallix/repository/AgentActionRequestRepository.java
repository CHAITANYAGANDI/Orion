package com.recallix.repository;

import com.recallix.entity.AgentActionRequest;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface AgentActionRequestRepository extends JpaRepository<AgentActionRequest, String> {
    List<AgentActionRequest> findByUserIdOrderByCreatedAtDesc(String userId);
    Optional<AgentActionRequest> findByIdAndUserId(String id, String userId);
}
