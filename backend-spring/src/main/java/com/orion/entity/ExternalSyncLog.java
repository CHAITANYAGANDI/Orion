package com.orion.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/** Phase 2: traceability for each call to an external provider. */
@Entity
@Table(name = "external_sync_logs")
public class ExternalSyncLog {

    @Id
    private String id;

    @Column(name = "user_id")
    private String userId;

    private String provider;

    @Column(name = "external_entity_id")
    private String externalEntityId;

    @Column(name = "action_request_id")
    private String actionRequestId;

    private String status;

    @Column(name = "error_message")
    private String errorMessage;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }

    public String getExternalEntityId() { return externalEntityId; }
    public void setExternalEntityId(String externalEntityId) { this.externalEntityId = externalEntityId; }

    public String getActionRequestId() { return actionRequestId; }
    public void setActionRequestId(String actionRequestId) { this.actionRequestId = actionRequestId; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getErrorMessage() { return errorMessage; }
    public void setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
