package com.orion.repository;

import com.orion.entity.ExternalSyncLog;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ExternalSyncLogRepository extends JpaRepository<ExternalSyncLog, String> {
}
