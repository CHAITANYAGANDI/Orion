package com.reverie.dto;

import com.reverie.entity.TranscriptSegment;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Talk-time percentage.
 *
 * <p>The number people check is whether the percentages add up, so most of
 * these are about the denominator rather than the arithmetic.
 */
class SpeakerStatsDtoTest {

    @Test
    void splits_speaking_time_between_speakers() {
        var stats = SpeakerStatsDto.from(List.of(
                segment("Alice", 0.0, 30.0),
                segment("Bob", 30.0, 40.0)));

        assertThat(stats).hasSize(2);
        assertThat(stats.get(0).speaker()).isEqualTo("Alice");
        assertThat(stats.get(0).percentage()).isEqualTo(75.0);
        assertThat(stats.get(1).percentage()).isEqualTo(25.0);
    }

    @Test
    void percentages_are_of_speaking_time_not_wall_clock() {
        // A 10s gap between the two turns. Measured against elapsed time these
        // would sum to 50%, which reads as a bug to anyone adding them up.
        var stats = SpeakerStatsDto.from(List.of(
                segment("Alice", 0.0, 10.0),
                segment("Bob", 20.0, 30.0)));

        assertThat(stats).extracting(SpeakerStatsDto::percentage)
                .containsExactly(50.0, 50.0);
    }

    @Test
    void orders_by_who_spoke_most() {
        var stats = SpeakerStatsDto.from(List.of(
                segment("Quiet", 0.0, 1.0),
                segment("Loud", 1.0, 60.0)));

        assertThat(stats).extracting(SpeakerStatsDto::speaker)
                .containsExactly("Loud", "Quiet");
    }

    @Test
    void sums_the_turns_of_a_speaker_who_talks_more_than_once() {
        var stats = SpeakerStatsDto.from(List.of(
                segment("Alice", 0.0, 10.0),
                segment("Bob", 10.0, 20.0),
                segment("Alice", 20.0, 30.0)));

        assertThat(stats.get(0).speaker()).isEqualTo("Alice");
        assertThat(stats.get(0).speakingSeconds()).isEqualTo(20.0);
        assertThat(stats.get(0).segmentCount()).isEqualTo(2);
    }

    @Test
    void ignores_segments_with_no_speaker() {
        // A document or an undiarized transcript, which has text but nobody to
        // attribute it to.
        var stats = SpeakerStatsDto.from(List.of(
                segment(null, 0.0, 10.0),
                segment("  ", 10.0, 20.0)));

        assertThat(stats).isEmpty();
    }

    @Test
    void a_transcript_without_timings_reports_zero_rather_than_dividing_by_zero() {
        // Imported transcripts can arrive with every segment at 0.0.
        var stats = SpeakerStatsDto.from(List.of(
                segment("Alice", 0.0, 0.0),
                segment("Bob", 0.0, 0.0)));

        assertThat(stats).extracting(SpeakerStatsDto::percentage)
                .containsExactly(0.0, 0.0);
    }

    @Test
    void a_malformed_segment_does_not_subtract_from_a_speakers_total() {
        // end before start: clamped at zero rather than counted as negative
        // time, which would otherwise make another speaker exceed 100%.
        var stats = SpeakerStatsDto.from(List.of(
                segment("Alice", 10.0, 5.0),
                segment("Bob", 0.0, 10.0)));

        assertThat(stats).extracting(SpeakerStatsDto::speaker).containsExactly("Bob", "Alice");
        assertThat(stats.get(1).speakingSeconds()).isEqualTo(0.0);
        assertThat(stats.get(0).percentage()).isEqualTo(100.0);
    }

    @Test
    void counts_words_per_speaker() {
        var stats = SpeakerStatsDto.from(List.of(
                segment("Alice", 0.0, 5.0, "one two three")));

        assertThat(stats.get(0).wordCount()).isEqualTo(3);
    }

    @Test
    void groups_by_canonical_identity_so_the_chart_matches_the_transcript() {
        // Before canonical numbering the two could disagree outright: the
        // transcript said Speaker 1 and Speaker 2 while the chart said
        // Speaker 1 and Speaker 4, because the provider had clustered the
        // second voice as "D" and the label was decoded by alphabet position.
        var stats = SpeakerStatsDto.from(List.of(
                keyed("Speaker 1", "spk_1", 0.0, 30.0),
                keyed("Speaker 2", "spk_2", 30.0, 40.0),
                keyed("Speaker 1", "spk_1", 40.0, 50.0)));

        assertThat(stats).extracting(SpeakerStatsDto::speaker)
                .containsExactly("Speaker 1", "Speaker 2");
        assertThat(stats).extracting(SpeakerStatsDto::speakerKey)
                .containsExactly("spk_1", "spk_2");
        assertThat(stats.get(0).segmentCount()).isEqualTo(2);
    }

    @Test
    void two_labels_renamed_to_one_person_become_one_row() {
        // Renaming both to the same person is how a user says "these two
        // labels are one human". Two rows both saying "Sarah" would read as a
        // bug, and the transcript already merges them.
        var stats = SpeakerStatsDto.from(List.of(
                keyed("Sarah", "spk_1", 0.0, 10.0),
                keyed("Sarah", "spk_2", 10.0, 30.0)));

        assertThat(stats).hasSize(1);
        assertThat(stats.get(0).speakingSeconds()).isEqualTo(30.0);
        // Coloured from the first of them, so the chart and the transcript
        // agree rather than each picking their own.
        assertThat(stats.get(0).speakerKey()).isEqualTo("spk_1");
    }

    @Test
    void a_transcript_recorded_before_canonical_keys_still_groups_by_name() {
        // Those rows have no key at all, and must go on behaving exactly as
        // they did rather than collapsing into one unkeyed speaker.
        var stats = SpeakerStatsDto.from(List.of(
                segment("Alice", 0.0, 30.0),
                segment("Bob", 30.0, 40.0)));

        assertThat(stats).extracting(SpeakerStatsDto::speaker)
                .containsExactly("Alice", "Bob");
        assertThat(stats).extracting(SpeakerStatsDto::speakerKey)
                .containsOnlyNulls();
    }

    private static TranscriptSegment keyed(String speaker, String key, double start, double end) {
        var segment = segment(speaker, start, end);
        segment.setId("seg_" + key + start);
        segment.setSpeakerKey(key);
        return segment;
    }

    private static TranscriptSegment segment(String speaker, double start, double end) {
        return segment(speaker, start, end, "text here");
    }

    private static TranscriptSegment segment(String speaker, double start, double end, String text) {
        var segment = new TranscriptSegment();
        segment.setId("seg_" + speaker + start);
        segment.setSpeaker(speaker);
        segment.setStartTime(start);
        segment.setEndTime(end);
        segment.setText(text);
        return segment;
    }
}
