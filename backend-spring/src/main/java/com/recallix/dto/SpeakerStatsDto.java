package com.recallix.dto;

import com.recallix.entity.TranscriptSegment;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * How much of a meeting one speaker actually held the floor.
 *
 * <p>Derived on read rather than stored: it is a pure function of the segments,
 * and the segments move — a rename merges two labels into one, an edit changes
 * the text, a rematch reassigns a turn. A stored copy would be wrong after
 * every one of those and would need invalidating in four places.
 */
public record SpeakerStatsDto(
        String speaker,
        /** Seconds this speaker was talking, summed across their turns. */
        double speakingSeconds,
        /** Share of total *speaking* time, 0-100, rounded to one decimal. */
        double percentage,
        int segmentCount,
        int wordCount
) {

    /**
     * Talk-time per speaker, ordered by who spoke most.
     *
     * <p>The denominator is total speaking time, not the meeting's wall-clock
     * duration. Those differ whenever there is silence or crosstalk, and a set
     * of percentages that does not add up to 100 reads as a bug — "40% of the
     * talking" is the claim being made, and it is the one people check.
     */
    public static List<SpeakerStatsDto> from(List<TranscriptSegment> segments) {
        Map<String, double[]> totals = new LinkedHashMap<>();  // speaker -> [seconds, segments, words]

        for (TranscriptSegment segment : segments) {
            String speaker = segment.getSpeaker();
            if (speaker == null || speaker.isBlank()) {
                continue;
            }
            double start = segment.getStartTime() == null ? 0.0 : segment.getStartTime();
            double end = segment.getEndTime() == null ? 0.0 : segment.getEndTime();
            // Clamped at zero: a malformed segment with end before start would
            // otherwise subtract from that speaker's total.
            double seconds = Math.max(0.0, end - start);

            double[] running = totals.computeIfAbsent(speaker.trim(), key -> new double[3]);
            running[0] += seconds;
            running[1] += 1;
            running[2] += wordsIn(segment.getText());
        }

        double spoken = totals.values().stream().mapToDouble(t -> t[0]).sum();

        return totals.entrySet().stream()
                .map(entry -> new SpeakerStatsDto(
                        entry.getKey(),
                        round(entry.getValue()[0]),
                        // Zero rather than a division by zero when every
                        // segment is zero-length, which is what a transcript
                        // imported without timings looks like.
                        spoken <= 0 ? 0.0 : round(entry.getValue()[0] / spoken * 100.0),
                        (int) entry.getValue()[1],
                        (int) entry.getValue()[2]))
                .sorted(Comparator.comparingDouble(SpeakerStatsDto::speakingSeconds).reversed())
                .toList();
    }

    private static int wordsIn(String text) {
        if (text == null || text.isBlank()) {
            return 0;
        }
        return text.trim().split("\\s+").length;
    }

    private static double round(double value) {
        return Math.round(value * 10.0) / 10.0;
    }
}
