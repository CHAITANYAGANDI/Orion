package com.recallix.entity;

import com.recallix.domain.SummarySection;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import com.recallix.domain.Quotation;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "meeting_summaries")
public class MeetingSummary {

    @Id
    private String id;

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    @Column(name = "short_summary")
    private String shortSummary;

    @Column(name = "detailed_summary")
    private String detailedSummary;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "key_points_json", columnDefinition = "jsonb")
    private List<String> keyPoints = new ArrayList<>();

    /**
     * The template's sections in order. Empty for summaries written before
     * templates existed, which still render from the three fields above.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "sections_json", columnDefinition = "jsonb")
    private List<SummarySection> sections = new ArrayList<>();

    /**
     * Quotations already verified against the transcript by the worker. Empty
     * for summaries generated before V22, and whenever nothing verified — which
     * is a normal outcome, not a failure.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "quotes_json", columnDefinition = "jsonb")
    private List<Quotation> quotes = new ArrayList<>();

    /** Which template produced this summary; null for pre-template summaries. */
    @Column(name = "template_slug")
    private String templateSlug;

    /**
     * True when the transcript was edited after this summary was written.
     *
     * <p>The summary is not regenerated on an edit — that would spend a model
     * call per typo fix — so this is what tells the reader that the notes above
     * the transcript and the transcript itself no longer agree.
     */
    @Column(nullable = false)
    private boolean stale = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public String getShortSummary() { return shortSummary; }
    public void setShortSummary(String shortSummary) { this.shortSummary = shortSummary; }

    public String getDetailedSummary() { return detailedSummary; }
    public void setDetailedSummary(String detailedSummary) { this.detailedSummary = detailedSummary; }

    public List<String> getKeyPoints() { return keyPoints; }
    public void setKeyPoints(List<String> keyPoints) { this.keyPoints = keyPoints; }

    public List<SummarySection> getSections() { return sections; }
    public void setSections(List<SummarySection> sections) { this.sections = sections; }

    public String getTemplateSlug() { return templateSlug; }
    public void setTemplateSlug(String templateSlug) { this.templateSlug = templateSlug; }

    public boolean isStale() { return stale; }
    public void setStale(boolean stale) { this.stale = stale; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public List<Quotation> getQuotes() { return quotes; }
    public void setQuotes(List<Quotation> quotes) { this.quotes = quotes; }
}
