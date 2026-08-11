package com.recallix.entity;

import com.recallix.domain.SpokenWord;
import jakarta.persistence.Column;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.util.ArrayList;
import java.util.List;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "transcript_segments")
public class TranscriptSegment {

    @Id
    private String id;

    @Column(name = "meeting_id", nullable = false)
    private String meetingId;

    @Column(name = "start_time")
    private Double startTime;

    @Column(name = "end_time")
    private Double endTime;

    private String speaker;

    private String text;

    /**
     * Per-word timings, driving the highlight and click-to-seek in the
     * transcript view. Empty for segments recorded before V13, which fall back
     * to estimating from the segment span.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "words_json", columnDefinition = "jsonb")
    private List<SpokenWord> words = new ArrayList<>();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public Double getStartTime() { return startTime; }
    public void setStartTime(Double startTime) { this.startTime = startTime; }

    public Double getEndTime() { return endTime; }
    public void setEndTime(Double endTime) { this.endTime = endTime; }

    public List<SpokenWord> getWords() { return words; }
    public void setWords(List<SpokenWord> words) { this.words = words; }

    public String getSpeaker() { return speaker; }
    public void setSpeaker(String speaker) { this.speaker = speaker; }

    public String getText() { return text; }
    public void setText(String text) { this.text = text; }
}
