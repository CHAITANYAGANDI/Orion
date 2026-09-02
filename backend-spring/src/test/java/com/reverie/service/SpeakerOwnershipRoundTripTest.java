package com.reverie.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.reverie.dto.callback.AiSegment;
import com.reverie.dto.callback.MeetingBriefResult;
import com.reverie.repository.TranscriptSegmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Diarized ownership, followed through every layer that could drop it.
 *
 * <p>A four-minute two-person recording was reported rendering as
 * <b>Speaker 1 (100%)</b>. The ai-service side of that is settled in
 * {@code ai-service/tests/test_naming_is_an_overlay.py}, which proves automatic
 * transcript naming writes the display name and nothing else. This is the other
 * half, and it exists because "the pipeline is correct" is not the same claim as
 * "the transcript on screen is correct": between the two there is a JSON
 * boundary, a delete-and-reinsert, a projection into a response DTO and a
 * statistics pass, and any one of them could quietly merge two speakers.
 *
 * <p>So one conversation goes in as <b>A, B, A, B</b> and is checked at every
 * layer it passes through:
 *
 * <pre>
 *   ai-service JSON  ->  MeetingBriefResult  ->  transcript_segments rows
 *                    ->  GET transcript DTO  ->  SpeakerStatsDto
 * </pre>
 *
 * <p>The names on those four turns are <em>inferred</em> ones — Charles and
 * Michael, as the naming pass would have written them — because the failure
 * being guarded against is precisely a display name being mistaken for an
 * identity somewhere along the way.
 *
 * <p><strong>Needs a PostgreSQL, and skips without one.</strong> Same switch as
 * the other integration tests. A mock repository would prove that the mock
 * returns what it was told, which is the one thing not in doubt.
 */
@SpringBootTest
@EnabledIfEnvironmentVariable(named = "REVERIE_IT_DB_URL", matches = ".+",
        disabledReason = "needs a PostgreSQL to round-trip real segment rows")
class SpeakerOwnershipRoundTripTest {

    @DynamicPropertySource
    static void realDatabaseAndNoBroker(DynamicPropertyRegistry registry) {
        String url = System.getenv("REVERIE_IT_DB_URL");
        String owner = env("REVERIE_IT_DB_OWNER_USER", "REVERIE_IT_DB_USER");
        String password = env("REVERIE_IT_DB_OWNER_PASSWORD", "REVERIE_IT_DB_PASSWORD");

        registry.add("spring.datasource.url", () -> url);
        registry.add("spring.datasource.username", () -> owner);
        registry.add("spring.datasource.password", () -> password);
        registry.add("spring.flyway.url", () -> url);
        registry.add("spring.flyway.user", () -> owner);
        registry.add("spring.flyway.password", () -> password);
        registry.add("reverie.datasource.system.username", () -> owner);
        registry.add("reverie.datasource.system.password", () -> password);

        registry.add("spring.kafka.bootstrap-servers", () -> "localhost:1");
        registry.add("spring.kafka.security.protocol", () -> "PLAINTEXT");
        registry.add("spring.kafka.properties.default.api.timeout.ms", () -> "1000");
        registry.add("spring.kafka.properties.request.timeout.ms", () -> "1000");
        registry.add("spring.kafka.admin.fail-fast", () -> "false");
        registry.add("spring.kafka.admin.auto-create", () -> "false");
        registry.add("reverie.outbox.poll-ms", () -> "3600000");
    }

    private static String env(String preferred, String fallback) {
        String value = System.getenv(preferred);
        if (value == null || value.isBlank()) {
            value = System.getenv(fallback);
        }
        return value == null ? "" : value;
    }

    @Autowired private CallbackService callbacks;
    @Autowired private MeetingService meetings;
    @Autowired private TranscriptSegmentRepository segments;
    @Autowired private ObjectMapper json;

    private final String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    private final String userId = "usr_rt_" + suffix;
    private final String meetingId = "mtg_rt_" + suffix;

    /**
     * Exactly what the ai-service puts on the wire, as a string.
     *
     * <p>Written out as JSON rather than constructed as objects so the test
     * crosses the boundary the worker actually crosses. A field that Jackson
     * silently drops — a rename, a missing setter, a camelCase mismatch — is
     * invisible to a test that hands Spring an object it built itself.
     */
    private static final String CALLBACK_JSON = """
            {
              "meetingId": "PLACEHOLDER",
              "transcript": "Charles: Hi Michael, how are you?\\nMichael: I'm good, Charles.\\nCharles: Did you finish the deployment?\\nMichael: Yes.",
              "language": "en",
              "shortSummary": "A short exchange.",
              "detailedSummary": "Two colleagues greet each other and discuss a deployment.",
              "keyPoints": [],
              "actionItems": [],
              "segments": [
                {"start": 0.0,  "end": 3.0,  "speaker": "Charles", "text": "Hi Michael, how are you?",
                 "speakerKey": "spk_1", "speakerRaw": "A", "speakerStatus": "attributed"},
                {"start": 3.2,  "end": 6.0,  "speaker": "Michael", "text": "I'm good, Charles.",
                 "speakerKey": "spk_2", "speakerRaw": "B", "speakerStatus": "attributed"},
                {"start": 6.2,  "end": 10.0, "speaker": "Charles", "text": "Did you finish the deployment?",
                 "speakerKey": "spk_1", "speakerRaw": "A", "speakerStatus": "attributed"},
                {"start": 10.2, "end": 11.0, "speaker": "Michael", "text": "Yes.",
                 "speakerKey": "spk_2", "speakerRaw": "B", "speakerStatus": "attributed"}
              ]
            }
            """;

    @BeforeEach
    void aMeetingToPersistInto() throws Exception {
        try (Connection c = connect()) {
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO users (id, clerk_user_id, plan) VALUES (?, ?, 'FREE')")) {
                ps.setString(1, userId);
                ps.setString(2, "clerk_rt_" + suffix);
                ps.executeUpdate();
            }
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO meetings (id, user_id, title, status, source_type) "
                            + "VALUES (?, ?, 'Round trip', 'EXTRACTING', 'AUDIO')")) {
                ps.setString(1, meetingId);
                ps.setString(2, userId);
                ps.executeUpdate();
            }
        }
        var result = json.readValue(
                CALLBACK_JSON.replace("PLACEHOLDER", meetingId), MeetingBriefResult.class);
        callbacks.applyResult(meetingId, result);
    }

    @Nested
    @DisplayName("the callback JSON")
    class Wire {

        @Test
        void carries_every_speaker_field_across_the_boundary() throws Exception {
            var result = json.readValue(
                    CALLBACK_JSON.replace("PLACEHOLDER", meetingId), MeetingBriefResult.class);

            assertThat(result.segmentsOrEmpty()).extracting(AiSegment::speakerRaw)
                    .containsExactly("A", "B", "A", "B");
            assertThat(result.segmentsOrEmpty()).extracting(AiSegment::speakerKey)
                    .containsExactly("spk_1", "spk_2", "spk_1", "spk_2");
            // The display name is the only one that carries an inferred value,
            // and it travels in its own field beside the other two rather than
            // replacing either of them.
            assertThat(result.segmentsOrEmpty()).extracting(AiSegment::speaker)
                    .containsExactly("Charles", "Michael", "Charles", "Michael");
        }
    }

    @Nested
    @DisplayName("the rows")
    class Persistence {

        @Test
        void keep_the_provider_token_and_the_canonical_key_apart() {
            var rows = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);

            assertThat(rows).hasSize(4);
            assertThat(rows).extracting(s -> s.getSpeakerRaw())
                    .containsExactly("A", "B", "A", "B");
            assertThat(rows).extracting(s -> s.getSpeakerKey())
                    .containsExactly("spk_1", "spk_2", "spk_1", "spk_2");
            assertThat(rows).extracting(s -> s.getSpeaker())
                    .containsExactly("Charles", "Michael", "Charles", "Michael");
        }

        @Test
        void two_speakers_went_in_and_two_came_out() {
            var rows = segments.findByMeetingIdOrderByStartTimeAsc(meetingId);

            // Four turns, two people. The count is the whole assertion: one is
            // the reported bug and four would mean the alternation was lost the
            // other way, by giving every utterance its own speaker.
            assertThat(rows.stream().map(s -> s.getSpeakerKey()).distinct()).hasSize(2);
            assertThat(rows.stream().map(s -> s.getSpeakerRaw()).distinct()).hasSize(2);
        }
    }

    @Nested
    @DisplayName("the transcript API")
    class Api {

        @Test
        void hands_the_client_the_canonical_key_alternating() {
            var response = meetings.getTranscript(userId, meetingId);

            assertThat(response.segments()).extracting(s -> s.speakerKey())
                    .containsExactly("spk_1", "spk_2", "spk_1", "spk_2");
            assertThat(response.segments()).extracting(s -> s.speaker())
                    .containsExactly("Charles", "Michael", "Charles", "Michael");
        }

        @Test
        void serialises_the_key_the_client_groups_on() throws Exception {
            // The frontend merges consecutive utterances on `speakerKey` and
            // deliberately not on the name, so the field has to survive
            // serialisation. `speakerRaw` is deliberately absent — it is the
            // provider's internal cluster id and nothing on screen needs it.
            String body = json.writeValueAsString(meetings.getTranscript(userId, meetingId));

            assertThat(body).contains("\"speakerKey\":\"spk_1\"", "\"speakerKey\":\"spk_2\"");
            assertThat(body).doesNotContain("speakerRaw");
        }
    }

    @Nested
    @DisplayName("the statistics")
    class Stats {

        @Test
        void report_two_speakers_and_never_one_at_a_hundred_percent() {
            var response = meetings.getTranscript(userId, meetingId);

            assertThat(response.speakers()).hasSize(2);
            assertThat(response.speakers()).extracting(s -> s.percentage())
                    .doesNotContain(100.0);
            assertThat(response.speakers()).extracting(s -> s.speaker())
                    .containsExactlyInAnyOrder("Charles", "Michael");
            assertThat(response.speakers()).extracting(s -> s.speakerKey())
                    .containsExactlyInAnyOrder("spk_1", "spk_2");
        }

        @Test
        void share_the_floor_in_proportion_to_the_seconds_each_held_it() {
            // Charles: 3.0 + 3.8 = 6.8s.  Michael: 2.8 + 0.8 = 3.6s.
            var stats = meetings.getTranscript(userId, meetingId).speakers();

            assertThat(stats.get(0).speaker()).isEqualTo("Charles");
            assertThat(stats.get(0).speakingSeconds()).isEqualTo(6.8);
            assertThat(stats.get(1).speakingSeconds()).isEqualTo(3.6);
            assertThat(stats.stream().mapToDouble(s -> s.percentage()).sum())
                    .isCloseTo(100.0, org.assertj.core.data.Offset.offset(0.2));
        }
    }

    private static Connection connect() throws Exception {
        return DriverManager.getConnection(
                System.getenv("REVERIE_IT_DB_URL"),
                env("REVERIE_IT_DB_OWNER_USER", "REVERIE_IT_DB_USER"),
                env("REVERIE_IT_DB_OWNER_PASSWORD", "REVERIE_IT_DB_PASSWORD"));
    }
}
