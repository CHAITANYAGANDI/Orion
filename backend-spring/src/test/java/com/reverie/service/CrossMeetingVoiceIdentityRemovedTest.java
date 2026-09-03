package com.reverie.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.reverie.controller.MeetingController;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Cross-meeting voice identity is gone from the product surface.
 *
 * <p>Stage 3A removed the feature at the application layer: no endpoint, no
 * service, no entity, no stored-voice wording. What it deliberately did
 * <em>not</em> remove is the data — {@code speaker_profiles} and
 * {@code meeting_speaker_voiceprints} still exist, still hold rows, and are
 * dropped in a later stage with its own migration.
 *
 * <p>The tests here are the ones that would notice it coming back. The failure
 * that matters is not a leftover file; it is a rename quietly meaning "learn
 * this person's voice" again, which is invisible from the transcript and is the
 * one thing a user consented to separately.
 */
class CrossMeetingVoiceIdentityRemovedTest {

    private static final Path MAIN = Path.of("src", "main", "java", "com", "reverie");

    private static Stream<Path> sources() throws Exception {
        return Files.walk(MAIN).filter(p -> p.toString().endsWith(".java"));
    }

    @Test
    @DisplayName("the classes that ran it are gone")
    void theClassesAreGone() {
        for (String name : new String[] {
                "com.reverie.service.SpeakerIdentityService",
                "com.reverie.controller.SpeakerProfileController",
                "com.reverie.entity.SpeakerProfile",
                "com.reverie.repository.SpeakerProfileRepository",
                "com.reverie.dto.SpeakerRematchResponse",
                "com.reverie.dto.SpeakerProfileResponse",
                "com.reverie.dto.SpeakerSettingsResponse",
        }) {
            assertThatThrownBy(() -> Class.forName(name))
                    .as(name)
                    .isInstanceOf(ClassNotFoundException.class);
        }
    }

    @Test
    @DisplayName("no rematch endpoint is mapped")
    void noRematchEndpoint() {
        assertThat(Arrays.stream(MeetingController.class.getMethods()).map(Method::getName))
                .noneMatch(n -> n.toLowerCase().contains("rematch"));
    }

    @Test
    @DisplayName("renaming a speaker no longer calls anything that learns a voice")
    void renameDoesNotLearn() throws Exception {
        // The behavioural heart of stage 3A. A rename means "rename this
        // speaker in this meeting" and must not also mean "remember this voice".
        String service = Files.readString(MAIN.resolve("service/MeetingService.java"));

        assertThat(service).doesNotContain("learnFromRename");
        assertThat(service).doesNotContain("learnSpeaker");
        assertThat(service).doesNotContain("speakerIdentity");
        // And the rename itself is still here, doing its meeting-local job.
        assertThat(service).contains("public TranscriptResponse renameSpeakers(");
        assertThat(service).contains("public TranscriptResponse setSegmentSpeaker(");
    }

    @Test
    @DisplayName("the ai-service client offers no speaker identity calls")
    void theClientCannotAskForIt() throws Exception {
        String client = Files.readString(MAIN.resolve("service/AiClient.java"));

        for (String gone : new String[] {
                "/ai/speakers/identify", "/ai/speakers/learn", "/ai/speakers/forget",
                "identifySpeakers", "learnSpeaker", "forgetSpeakers", "SpeakerTurns",
        }) {
            assertThat(client).as(gone).doesNotContain(gone);
        }
        // MP3 export shares this class and is untouched.
        assertThat(client).contains("transcodeToMp3");
    }

    @Test
    @DisplayName("no user-visible wording claims a voice is remembered")
    void noWordingSurvives() throws Exception {
        // String literals only, which is where product wording lives. Comments
        // are allowed to say the feature was removed -- that is history, and
        // deleting the record of why something went is its own kind of damage.
        // Migrations are excluded for the same reason and a stronger one: the
        // tables are still there in this stage.
        String[] banned = {
                "rematch", "voice profile", "voice template",
                "remembered speaker", "saved voice", "learn this voice",
        };
        try (Stream<Path> files = sources()) {
            for (Path file : files.toList()) {
                // Split on the quote character: the odd-numbered pieces are the
                // string literals. Crude, and enough — it cannot miss a literal,
                // it can only include a little more than one, and every extra
                // piece it looks at is another chance to catch the wording.
                String[] pieces = Files.readString(file).split("\"");
                for (int i = 1; i < pieces.length; i += 2) {
                    String text = pieces[i].toLowerCase();
                    for (String phrase : banned) {
                        assertThat(text).as("%s in %s", phrase, file).doesNotContain(phrase);
                    }
                }
            }
        }
    }

    @Test
    @DisplayName("the voice-template tables are NOT dropped in this stage")
    void theDataIsStillThere() throws Exception {
        // Deliberate, and asserted so that deleting it stays a decision rather
        // than a side effect. V53 is untouched; stage 3B removes the rows.
        Path v53 = Path.of("src", "main", "resources", "db", "migration",
                "V53__speaker_profiles.sql");

        assertThat(Files.exists(v53)).isTrue();
        String sql = Files.readString(v53);
        assertThat(sql).contains("speaker_profiles");
        assertThat(sql).contains("meeting_speaker_voiceprints");
    }
}
