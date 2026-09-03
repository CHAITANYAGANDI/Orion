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
 * service, no entity, no stored-voice wording. Stage 3B removed the schema and
 * the data with it — V68 drops both tables and the consent column, erasing
 * every encrypted voice template that was still held.
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
        // Migrations are not scanned at all: this walks the Java sources.
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
    @DisplayName("a forward-only migration drops the schema and the templates")
    void theSchemaIsRemoved() throws Exception {
        Path migrations = Path.of("src", "main", "resources", "db", "migration");
        String removal = Files.readString(
                migrations.resolve("V68__remove_speaker_voice_profiles.sql"));

        // The cache before the profiles: neither has a foreign key to the other,
        // so this is for the reader rather than for Postgres.
        assertThat(removal.indexOf("DROP TABLE IF EXISTS meeting_speaker_voiceprints"))
                .isGreaterThan(0)
                .isLessThan(removal.indexOf("DROP TABLE IF EXISTS speaker_profiles"));
        assertThat(removal).contains("DROP COLUMN IF EXISTS speaker_learning_enabled");
        // No CASCADE in the SQL itself -- an unexpected dependent should fail
        // the migration rather than be silently taken with the table. Checked
        // on the statements only, because the comment above them explains the
        // choice and has to be able to say the word.
        String statements = removal.lines()
                .filter(line -> !line.stripLeading().startsWith("--"))
                .collect(java.util.stream.Collectors.joining(" "));
        assertThat(statements).doesNotContain("CASCADE");
        // And it says why, in the words the erasure decision was made in.
        assertThat(removal).contains("intentionally erased");
    }

    @Test
    @DisplayName("V53 is never edited, because production has already applied it")
    void theOriginalMigrationIsUntouched() throws Exception {
        Path v53 = Path.of("src", "main", "resources", "db", "migration",
                "V53__speaker_profiles.sql");

        // Still present and still describing what it created. A migration that
        // has run somewhere is a historical fact; rewriting it changes a
        // checksum and breaks every database that already has it.
        assertThat(Files.exists(v53)).isTrue();
        String sql = Files.readString(v53);
        assertThat(sql).contains("CREATE TABLE IF NOT EXISTS speaker_profiles");
        assertThat(sql).contains("CREATE TABLE IF NOT EXISTS meeting_speaker_voiceprints");
    }

    @Test
    @DisplayName("no live code depends on the dropped schema")
    void noLiveCodeTouchesTheDroppedSchema() throws Exception {
        // The resurrection guard. Migrations are exempt: V53 created these and
        // V68 drops them, and both have to name them to do it.
        String[] dropped = {
                "speaker_profiles", "meeting_speaker_voiceprints",
                "speaker_learning_enabled",
        };
        java.util.List<String> offenders = new java.util.ArrayList<>();
        for (Path root : new Path[] {MAIN, Path.of("src", "test", "java", "com", "reverie")}) {
            try (Stream<Path> files = Files.walk(root)) {
                for (Path file : files.filter(f -> f.toString().endsWith(".java")).toList()) {
                    if (file.getFileName().toString().equals(
                            "CrossMeetingVoiceIdentityRemovedTest.java")) {
                        continue;
                    }
                    String text = Files.readString(file);
                    for (String name : dropped) {
                        if (text.contains(name)) {
                            offenders.add(file.getFileName() + ": " + name);
                        }
                    }
                }
            }
        }
        assertThat(offenders).isEmpty();
    }
}
