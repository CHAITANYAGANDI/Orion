package com.reverie.entity;

import com.reverie.domain.MomentRange;
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
 * Something a person marked in a transcript — a highlight, a bookmark or a
 * private note.
 *
 * <p>One entity for all three because they differ by which fields are filled
 * in, not by shape or lifecycle. See V27 for the full argument, and for why the
 * anchor is stored three ways.
 *
 * <p>{@code speaker} and the timestamps are denormalised from the segment
 * deliberately: reprocessing a meeting rebuilds {@code transcript_segments}
 * from scratch, so a moment that could only be described by joining to its
 * segment would become unreadable the first time someone asked for a better
 * transcription.
 */
@Entity
@Table(name = "transcript_moments")
public class TranscriptMoment {

    @Id
    private String id;

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    @Column(name = "user_id", nullable = false)
    private String userId;

    /** {@code HIGHLIGHT}, {@code BOOKMARK} or {@code NOTE}. */
    @Column(nullable = false)
    private String kind;

    /** Empty for a bookmark, which marks a time rather than a passage. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "ranges", columnDefinition = "jsonb")
    private List<MomentRange> ranges = new ArrayList<>();

    /** The selected words, joined. Duplicated out of {@link #ranges} so a list
     *  can be rendered and searched without unpacking JSON. */
    @Column(nullable = false)
    private String quote = "";

    /** The user's own words: a note's body, or a bookmark's label. */
    @Column(nullable = false)
    private String body = "";

    @Column(nullable = false)
    private String speaker = "";

    @Column(name = "start_seconds", nullable = false)
    private double startSeconds;

    @Column(name = "end_seconds", nullable = false)
    private double endSeconds;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getKind() { return kind; }
    public void setKind(String kind) { this.kind = kind; }

    public List<MomentRange> getRanges() { return ranges; }
    public void setRanges(List<MomentRange> ranges) { this.ranges = ranges; }

    public String getQuote() { return quote; }
    public void setQuote(String quote) { this.quote = quote; }

    public String getBody() { return body; }
    public void setBody(String body) { this.body = body; }

    public String getSpeaker() { return speaker; }
    public void setSpeaker(String speaker) { this.speaker = speaker; }

    public double getStartSeconds() { return startSeconds; }
    public void setStartSeconds(double startSeconds) { this.startSeconds = startSeconds; }

    public double getEndSeconds() { return endSeconds; }
    public void setEndSeconds(double endSeconds) { this.endSeconds = endSeconds; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
