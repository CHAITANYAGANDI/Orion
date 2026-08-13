package com.recallix.entity;

import com.recallix.domain.VocabularyCategory;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One transcription boosting hint, owned by a user.
 *
 * @see com.recallix.domain.VocabularyCategory
 */
@Entity
@Table(name = "vocabulary_terms")
public class VocabularyTerm {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(nullable = false)
    private String term;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private VocabularyCategory category;

    /** What an acronym stands for. Empty for every other category. */
    @Column(nullable = false)
    private String expansion = "";

    /**
     * Disabled terms stay in the list but are not sent to the transcriber, so a
     * hint that caused a bad boost can be switched off without being lost.
     */
    @Column(nullable = false)
    private boolean active = true;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getTerm() { return term; }
    public void setTerm(String term) { this.term = term; }

    public VocabularyCategory getCategory() { return category; }
    public void setCategory(VocabularyCategory category) { this.category = category; }

    public String getExpansion() { return expansion; }
    public void setExpansion(String expansion) { this.expansion = expansion; }

    public boolean isActive() { return active; }
    public void setActive(boolean active) { this.active = active; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
