package com.recallix.repository;

import com.recallix.entity.ExternalSyncLog;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ExternalSyncLogRepository extends JpaRepository<ExternalSyncLog, String> {
}
