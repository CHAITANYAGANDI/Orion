package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * A body of work meetings belong to — "Client ABC", "Interviews", "Q4
 * migration".
 *
 * <p>Not a folder, and the difference is not cosmetic: a project is a thing that
 * is happening, which is what makes asking questions of it sensible. The
 * grouping exists so the chat knows what to read.
 *
 * <p>Exactly one per meeting, or none. Tags remain the many-to-many way to
 * label a meeting; a second one would leave two answers to the same question.
 */
@Entity
@Table(name = "projects")
public class Project {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String description = "";

    /** A palette name chosen by the UI, so the dot follows the theme. */
    @Column(nullable = false)
    private String color = "";

    /**
     * Starred, and therefore listed first.
     *
     * <p>Not a second grouping — a starred project is the same project with a
     * sort key. See V37.
     */
    @Column(nullable = false)
    private boolean favorite = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @PreUpdate
    void onUpdate() {
        this.updatedAt = Instant.now();
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public String getColor() { return color; }
    public void setColor(String color) { this.color = color; }

    public boolean isFavorite() { return favorite; }
    public void setFavorite(boolean favorite) { this.favorite = favorite; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
