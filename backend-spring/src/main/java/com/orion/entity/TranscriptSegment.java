package com.orion.entity;

import com.orion.domain.SpokenWord;
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

    /**
     * ISO-639-1 code, set only when this utterance is in a different language
     * from the meeting's. Null means same-as-meeting or undetermined — see V21.
     */
    @Column(name = "language")
    private String language;

    /**
     * Meeting-local speaker identity ("spk_2"), stable across renames.
     *
     * <p>{@link #speaker} is the display name and is what a rename overwrites.
     * This is what a colour is picked from, so renaming Speaker 2 to Sarah
     * keeps her the same colour. Null for transcripts written before V46,
     * which fall back to keying on the display name as they always did.
     */
    @Column(name = "speaker_key")
    private String speakerKey;

    /**
     * The provider's own cluster id ("A", "D"). Never displayed.
     *
     * <p>Its value is diagnostic: the display label alone cannot tell you
     * whether the provider merged two people or Orion mislabelled one.
     */
    @Column(name = "speaker_raw")
    private String speakerRaw;

    /**
     * {@code attributed} or {@code unknown}.
     *
     * <p>"unknown" is a real answer and is rendered as one. A turn filed under
     * Speaker 1 because nothing better was known is a quotation beside a name
     * that may never have said it, and that misattribution travels into
     * summaries, action-item owners and exports.
     */
    @Column(name = "speaker_status")
    private String speakerStatus = "attributed";

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public Double getStartTime() { return startTime; }
    public void setStartTime(Double startTime) { this.startTime = startTime; }

    public Double getEndTime() { return endTime; }
    public void setEndTime(Double endTime) { this.endTime = endTime; }

    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }

    public List<SpokenWord> getWords() { return words; }
    public void setWords(List<SpokenWord> words) { this.words = words; }

    public String getSpeaker() { return speaker; }
    public void setSpeaker(String speaker) { this.speaker = speaker; }

    public String getSpeakerKey() { return speakerKey; }
    public void setSpeakerKey(String speakerKey) { this.speakerKey = speakerKey; }

    public String getSpeakerRaw() { return speakerRaw; }
    public void setSpeakerRaw(String speakerRaw) { this.speakerRaw = speakerRaw; }

    public String getSpeakerStatus() { return speakerStatus; }
    public void setSpeakerStatus(String speakerStatus) { this.speakerStatus = speakerStatus; }

    public String getText() { return text; }
    public void setText(String text) { this.text = text; }
}
