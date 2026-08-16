package com.recallix.entity;

import com.recallix.domain.SummarySection;
import com.recallix.domain.TranslatedLine;
import com.recallix.domain.TranslatedTask;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * One meeting rendered in one language.
 *
 * <p>Stored rather than recomputed because a transcript is thousands of words
 * and translating it costs real money and real seconds; see V33. The two halves
 * are translated independently — choosing a language translates the brief, and
 * the transcript follows only if somebody opens it and asks — which is what the
 * two nullable timestamps record.
 */
@Entity
@Table(name = "meeting_translations")
public class MeetingTranslation {

    @Id
    private String id;

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    /** ISO-639-1, always the bare two-letter code. */
    @Column(nullable = false)
    private String language;

    @Column(name = "short_summary", nullable = false)
    private String shortSummary = "";

    @Column(name = "detailed_summary", nullable = false)
    private String detailedSummary = "";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "key_points", columnDefinition = "jsonb", nullable = false)
    private List<String> keyPoints = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb", nullable = false)
    private List<SummarySection> sections = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "action_items", columnDefinition = "jsonb", nullable = false)
    private List<TranslatedTask> actionItems = new ArrayList<>();

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb", nullable = false)
    private List<TranslatedLine> segments = new ArrayList<>();

    /** Null until the brief has been translated at least once. */
    @Column(name = "brief_translated_at")
    private Instant briefTranslatedAt;

    /** Null until somebody asked for the transcript, which is the expensive half. */
    @Column(name = "transcript_translated_at")
    private Instant transcriptTranslatedAt;

    /** The meeting changed after this was made — see V25 for the same idea one layer in. */
    @Column(nullable = false)
    private boolean stale = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @PreUpdate
    void onUpdate() {
        this.updatedAt = Instant.now();
    }

    public boolean hasBrief() {
        return briefTranslatedAt != null;
    }

    public boolean hasTranscript() {
        return transcriptTranslatedAt != null;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }

    public String getShortSummary() { return shortSummary; }
    public void setShortSummary(String shortSummary) { this.shortSummary = shortSummary; }

    public String getDetailedSummary() { return detailedSummary; }
    public void setDetailedSummary(String detailedSummary) { this.detailedSummary = detailedSummary; }

    public List<String> getKeyPoints() { return keyPoints; }
    public void setKeyPoints(List<String> keyPoints) { this.keyPoints = keyPoints; }

    public List<SummarySection> getSections() { return sections; }
    public void setSections(List<SummarySection> sections) { this.sections = sections; }

    public List<TranslatedTask> getActionItems() { return actionItems; }
    public void setActionItems(List<TranslatedTask> actionItems) { this.actionItems = actionItems; }

    public List<TranslatedLine> getSegments() { return segments; }
    public void setSegments(List<TranslatedLine> segments) { this.segments = segments; }

    public Instant getBriefTranslatedAt() { return briefTranslatedAt; }
    public void setBriefTranslatedAt(Instant briefTranslatedAt) { this.briefTranslatedAt = briefTranslatedAt; }

    public Instant getTranscriptTranslatedAt() { return transcriptTranslatedAt; }
    public void setTranscriptTranslatedAt(Instant transcriptTranslatedAt) { this.transcriptTranslatedAt = transcriptTranslatedAt; }

    public boolean isStale() { return stale; }
    public void setStale(boolean stale) { this.stale = stale; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
