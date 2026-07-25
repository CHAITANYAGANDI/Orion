package com.recallix.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

/** Phase 2: a drafted external action awaiting approval / execution. */
@Entity
@Table(name = "agent_action_requests")
public class AgentActionRequest {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "meeting_id")
    private String meetingId;

    @Column(name = "action_type", nullable = false)
    private String actionType;

    private String provider;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "draft_payload_json", nullable = false, columnDefinition = "jsonb")
    private JsonNode draftPayload;

    @Column(nullable = false)
    private String status = "DRAFT";

    @Column(name = "approval_required", nullable = false)
    private boolean approvalRequired = true;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "executed_at")
    private Instant executedAt;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getActionType() { return actionType; }
    public void setActionType(String actionType) { this.actionType = actionType; }

    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }

    public JsonNode getDraftPayload() { return draftPayload; }
    public void setDraftPayload(JsonNode draftPayload) { this.draftPayload = draftPayload; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public boolean isApprovalRequired() { return approvalRequired; }
    public void setApprovalRequired(boolean approvalRequired) { this.approvalRequired = approvalRequired; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getExecutedAt() { return executedAt; }
    public void setExecutedAt(Instant executedAt) { this.executedAt = executedAt; }
}
