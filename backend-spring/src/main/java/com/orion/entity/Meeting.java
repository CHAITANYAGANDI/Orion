package com.orion.entity;

import com.orion.domain.MeetingStatus;
import com.orion.domain.SourceType;
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
     * a file that arrived over the upload page was captured somewhere Orion
     * was not present.
     *
     * <p>{@code sourceType} cannot answer this: a recording and an uploaded
     * audio file are both {@link SourceType#AUDIO} and reach the same endpoint.
     * Only the client knows which it is.
     */
    @Column(name = "recorded", nullable = false)
    private boolean recorded = false;

    /**
     * The title is ours, not theirs, and the worker may replace it (V52).
     *
     * <p>True for a browser recording, which is saved as
     * {@code Recording — 20/08/2026, 05:03:43} because at that moment the date
     * is all anybody knows. False for an uploaded file, which arrives with a
     * name its owner chose — and a filename, however dull, is still a decision
     * somebody made.
     *
     * <p>Cleared by {@code MeetingService.updateMeeting} on any rename, so a
     * name typed while the transcript is still processing wins over the one the
     * model writes a minute later. Whoever last named this meeting on purpose
     * should be the one whose name it keeps.
     */
    @Column(name = "auto_title", nullable = false)
    private boolean autoTitle = false;

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

    /**
     * Which processing run this meeting is on (V57).
     *
     * <p>1 at creation, incremented by {@code reprocess}. It is what separates
     * "the same run reported twice" from "the user asked for this again": the
     * first must charge once and notify once, the second must do both afresh.
     * Kafka delivery is at-least-once, so the first case is ordinary.
     */
    @Column(name = "processing_attempt", nullable = false)
    private int processingAttempt = 1;

    /** Detected transcription language, denormalised so list views stay one query. */
    @Column(name = "language")
    private String language;

    /**
     * The language the user says this meeting is in, or null to use the
     * account default (V42).
     *
     * <p>An input where {@link #language} is an output. Read at every enqueue,
     * so it survives a reprocess rather than being consumed by one.
     */
    @Column(name = "spoken_language")
    private String spokenLanguage;

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
     * <p>Their assertion, kept — not something Orion can check. Set only for
     * meetings captured in the browser, which is the only path that asks.
     */
    @Column(name = "consent_confirmed_at")
    private Instant consentConfirmedAt;

    /**
     * How many voices to tell the transcriber to expect (V45).
     *
     * <p>Null on both is automatic, which is what every meeting recorded
     * before this existed still is. Stored on the meeting rather than on the
     * account because it is a fact about one recording: a 1:1 and an all-hands
     * belong to the same person.
     */
    @Column(name = "expected_speakers_min")
    private Integer expectedSpeakersMin;

    @Column(name = "expected_speakers_max")
    private Integer expectedSpeakersMax;

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

    public boolean isAutoTitle() { return autoTitle; }
    public void setAutoTitle(boolean autoTitle) { this.autoTitle = autoTitle; }

    public Integer getDurationSeconds() { return durationSeconds; }
    public void setDurationSeconds(Integer durationSeconds) { this.durationSeconds = durationSeconds; }


    public List<String> getTags() { return tags; }
    public void setTags(List<String> tags) { this.tags = tags; }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getErrorMessage() { return errorMessage; }
    public void setErrorMessage(String errorMessage) { this.errorMessage = errorMessage; }

    public int getProcessingAttempt() { return processingAttempt; }
    public void setProcessingAttempt(int processingAttempt) { this.processingAttempt = processingAttempt; }


    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }

    public String getSpokenLanguage() { return spokenLanguage; }
    public void setSpokenLanguage(String spokenLanguage) { this.spokenLanguage = spokenLanguage; }

    public Integer getExpectedSpeakersMin() { return expectedSpeakersMin; }
    public void setExpectedSpeakersMin(Integer v) { this.expectedSpeakersMin = v; }

    public Integer getExpectedSpeakersMax() { return expectedSpeakersMax; }
    public void setExpectedSpeakersMax(Integer v) { this.expectedSpeakersMax = v; }

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
