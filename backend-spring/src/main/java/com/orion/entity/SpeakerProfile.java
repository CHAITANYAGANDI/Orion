package com.orion.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * A voice the account holder has explicitly named, at least once.
 *
 * <p>Created only by the ai-service, and only when a human renames a speaker to
 * a real name. Nothing in Spring writes one: this entity exists so Settings can
 * list what is held and delete it, which are the two things the person whose
 * voice it is has a right to.
 *
 * <p><b>The embedding column is deliberately not mapped.</b> {@code embedding}
 * is a Fernet-encrypted ECAPA-TDNN vector, and Spring holds no key and has no
 * reason to. Leaving it off the entity is not an oversight to be tidied up
 * later — it means there is no code path in this service, present or future,
 * that can read a voice template into a response, a log line, an export or a
 * debugger, because the field simply is not here. The privacy boundary is
 * enforced by absence rather than by discipline.
 *
 * <p>See {@code V53__speaker_profiles.sql} for what the data is and the five
 * rules it is held under.
 */
@Entity
@Table(name = "speaker_profiles")
public class SpeakerProfile {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "display_name", nullable = false)
    private String displayName;

    /**
     * How many separately-named appearances have been averaged in.
     *
     * <p>Surfaced in Settings because it is the only thing that makes "why did
     * it match?" actionable: a profile built from one short turn is one the
     * user may reasonably want to delete and rebuild.
     */
    @Column(name = "sample_count", nullable = false)
    private int sampleCount = 1;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }

    public int getSampleCount() { return sampleCount; }
    public void setSampleCount(int sampleCount) { this.sampleCount = sampleCount; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
