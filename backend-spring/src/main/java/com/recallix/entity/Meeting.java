package com.recallix.entity;

import com.recallix.domain.MeetingStatus;
import com.recallix.domain.SourceType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "meetings")
public class Meeting {

    @Id
    private String id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(nullable = false)
    private String title;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private MeetingStatus status = MeetingStatus.CREATED;

    @Column(name = "audio_url")
    private String audioUrl;

    @Column(name = "object_key")
    private String objectKey;

    /**
     * Validated MIME type of the uploaded media, so the player can tell a video
     * from an audio file. Null for meetings created before V16 and for YouTube
     * imports, both of which the UI treats as audio.
     */
    @Column(name = "content_type")
    private String contentType;

    @Enumerated(EnumType.STRING)
    @Column(name = "source_type", nullable = false)
    private SourceType sourceType = SourceType.AUDIO;

    /** Only set for {@link SourceType#YOUTUBE}. */
    @Column(name = "source_url")
    private String sourceUrl;

    /**
     * Captured by the browser recorder rather than brought in (V40).
     *
     * <p>Asserted by the recorder and by no other client, so false covers both
     * "uploaded" and "we were never told" — which is the truthful reading, since
     * a file that arrived over the upload page was captured somewhere Recallix
     * was not present.
     *
     * <p>{@code sourceType} cannot answer this: a recording and an uploaded
     * audio file are both {@link SourceType#AUDIO} and reach the same endpoint.
     * Only the client knows which it is.
     */
    @Column(name = "recorded", nullable = false)
    private boolean recorded = false;

    @Column(name = "duration_seconds")
    private Integer durationSeconds;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private List<String> tags = new ArrayList<>();

    /**
     * The project this meeting is filed under, or null for unfiled.
     *
     * <p>A plain id rather than a {@code @ManyToOne}: every read that wants the
     * project name already has the project list in hand, and an association here
     * would have Hibernate fetch a row per meeting on any page that lists them.
     * See V30 for why there is exactly one, and why deleting a project only
     * clears this.
     */
    @Column(name = "project_id")
    private String projectId;

    @Column(name = "error_message")
    private String errorMessage;

    /** Set once the recap has been mailed, so a reprocess does not re-send it. */
    @Column(name = "recap_sent_at")
    private Instant recapSentAt;

    /** Detected transcription language, denormalised so list views stay one query. */
    @Column(name = "language")
    private String language;

    /**
     * Which summary shape this meeting is written in. Held on the meeting, not
     * the summary, so the choice survives a reprocess and so the meeting can be
     * re-summarized under a different template without re-transcribing it.
     * Validated against the ai-service's list before being stored.
     */
    @Column(name = "summary_template", nullable = false)
    private String summaryTemplate = "general";

    /**
     * When the recording was erased, or null if it never was.
     *
     * <p>Distinct from {@link #objectKey} being null, which is also true of a
     * YouTube import and of a meeting still being uploaded. A page that cannot
     * tell those apart has to say "no audio" to all three, which is the least
     * useful of the three things it could say.
     */
    @Column(name = "audio_deleted_at")
    private Instant audioDeletedAt;

    /** When the transcript was erased. The summary and tasks outlive it. */
    @Column(name = "transcript_deleted_at")
    private Instant transcriptDeletedAt;

    /**
     * When the person recording confirmed they had told everyone.
     *
     * <p>Their assertion, kept — not something Recallix can check. Set only for
     * meetings captured in the browser, which is the only path that asks.
     */
    @Column(name = "consent_confirmed_at")
    private Instant consentConfirmedAt;

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

    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }

    public MeetingStatus getStatus() { return status; }
    public void setStatus(MeetingStatus status) { this.status = status; }

    public String getAudioUrl() { return audioUrl; }
    public void setAudioUrl(String audioUrl) { this.audioUrl = audioUrl; }

    public String getObjectKey() { return objectKey; }
    public void setObjectKey(String objectKey) { this.objectKey = objectKey; }

    public String getContentType() { return contentType; }
    public void setContentType(String contentType) { this.contentType = contentType; }

    public SourceType getSourceType() { return sourceType; }
    public void setSourceType(SourceType sourceType) { this.sourceType = sourceType; }

    public String getSourceUrl() { return sourceUrl; }
    public void setSourceUrl(String sourceUrl) { this.sourceUrl = sourceUrl; }

    public boolean isRecorded() { return recorded; }
    public void setRecorded(boolean recorded) { this.recorded = recorded; }

    public Integer getDurationSeconds() { return durationSeconds; }
    public void setDurationSeconds(Integer durationSeconds) { this.durationSeconds = durationSeconds; }


    public List<String> getTags() { return tags; }
    public void setTags(List<String> tags) { this.tags = tags; }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getErrorMessage() { return errorMessage; }
    public void setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; }

    public Instant getRecapSentAt() { return recapSentAt; }
    public void setRecapSentAt(Instant recapSentAt) { this.recapSentAt = recapSentAt; }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }

    public String getSummaryTemplate() { return summaryTemplate; }
    public void setSummaryTemplate(String summaryTemplate) { this.summaryTemplate = summaryTemplate; }

    public Instant getAudioDeletedAt() { return audioDeletedAt; }
    public void setAudioDeletedAt(Instant audioDeletedAt) { this.audioDeletedAt = audioDeletedAt; }

    public Instant getTranscriptDeletedAt() { return transcriptDeletedAt; }
    public void setTranscriptDeletedAt(Instant transcriptDeletedAt) { this.transcriptDeletedAt = transcriptDeletedAt; }

    public Instant getConsentConfirmedAt() { return consentConfirmedAt; }
    public void setConsentConfirmedAt(Instant consentConfirmedAt) { this.consentConfirmedAt = consentConfirmedAt; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
