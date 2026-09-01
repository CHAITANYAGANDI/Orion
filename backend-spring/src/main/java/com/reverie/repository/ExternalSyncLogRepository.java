package com.reverie.repository;

import com.reverie.entity.ExternalSyncLog;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ExternalSyncLogRepository extends JpaRepository<ExternalSyncLog, String> {
}
