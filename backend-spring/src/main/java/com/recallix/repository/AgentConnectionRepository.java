package com.recallix.repository;

import com.recallix.entity.AgentConnection;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface AgentConnectionRepository extends JpaRepository<AgentConnection, String> {
    List<AgentConnection> findByUserId(String userId);
    Optional<AgentConnection> findByUserIdAndProvider(String userId, String provider);
}
