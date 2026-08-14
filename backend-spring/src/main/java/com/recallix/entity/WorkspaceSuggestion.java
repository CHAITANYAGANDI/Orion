package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Cached starter questions for one user's workspace chat.
 *
 * <p>One row per user, keyed by user id: this is a cache, not a history.
 * Keeping past generations would mean deciding which one is current on every
 * read, for no benefit — nobody wants last week's suggestions.
 *
 * <p>{@code generatedAt} is the whole freshness mechanism. It answers both
 * questions the cache has to answer: how old are these, and has a meeting
 * arrived since they were written.
 */
@Entity
@Table(name = "workspace_suggestions")
public class WorkspaceSuggestion {

    @Id
    @Column(name = "user_id")
    private String userId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "prompts_json", columnDefinition = "jsonb")
    private List<String> prompts = new ArrayList<>();

    @Column(name = "generated_at", nullable = false)
    private Instant generatedAt = Instant.now();

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public List<String> getPrompts() { return prompts; }
    public void setPrompts(List<String> prompts) { this.prompts = prompts; }

    public Instant getGeneratedAt() { return generatedAt; }
    public void setGeneratedAt(Instant generatedAt) { this.generatedAt = generatedAt; }
}
