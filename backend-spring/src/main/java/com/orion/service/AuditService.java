package com.orion.service;

import com.orion.common.IdGenerator;
import com.orion.entity.AuditLog;
import com.orion.repository.AuditLogRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Records security- and billing-relevant events (upload, export, delete, plan changes). */
@Service
public class AuditService {

    private final AuditLogRepository repo;

    public AuditService(AuditLogRepository repo) {
        this.repo = repo;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(String userId, String action, String entityType, String entityId) {
        AuditLog log = new AuditLog();
        log.setId(IdGenerator.audit());
        log.setUserId(userId);
        log.setAction(action);
        log.setEntityType(entityType);
        log.setEntityId(entityId);
        repo.save(log);
    }
}
