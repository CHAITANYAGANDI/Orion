package com.orion.export;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Where a converted recording lives, and whether one is needed at all.
 *
 * <p>Two rules, and both of them are load-bearing in a way that is easy to miss.
 *
 * <p>{@link AudioDerivatives#mp3Key} is the reason MP3 export needs no database
 * column: the object store is the record of what has been converted. That only
 * works while the function is total and stable — every caller must derive the
 * same key from the same recording, forever, including the erasure code that has
 * to find the derivative months later with nothing but the original's key.
 *
 * <p>{@link AudioDerivatives#isMp3} decides whether to spend a minute of CPU.
 * Wrong in one direction it re-encodes a file that was already an MP3, losing a
 * little quality for nothing; wrong in the other it hands back a webm named
 * {@code .mp3}, which is the bug this whole feature exists to prevent.
 */
class AudioDerivativesTest {

    @Nested
    @DisplayName("deciding whether a conversion is needed")
    class AlreadyMp3 {

        @Test
        void trustsWhatTheUploaderDeclared() {
            assertThat(AudioDerivatives.isMp3("audio/mpeg", "a/b.webm")).isTrue();
            assertThat(AudioDerivatives.isMp3("audio/mp3", "a/b.webm")).isTrue();
        }

        @Test
        void ignoresParametersAndCase() {
            // Browsers send "audio/webm;codecs=opus" and the odd client
            // capitalises. Neither changes what the bytes are.
            assertThat(AudioDerivatives.isMp3("AUDIO/MPEG; charset=binary", "a/b")).isTrue();
            assertThat(AudioDerivatives.isMp3("audio/webm;codecs=opus", "a/b")).isFalse();
        }

        @Test
        void saysNoForEverythingOrionActuallyRecords() {
            // The list that matters: a browser produces webm, a phone m4a, a
            // desk recorder wav, a screen capture mp4. Every one of these must
            // be converted rather than renamed.
            for (String type : new String[]{
                    "audio/webm", "audio/mp4", "audio/x-m4a", "audio/wav",
                    "audio/ogg", "audio/flac", "video/mp4", "video/webm"}) {
                assertThat(AudioDerivatives.isMp3(type, "a/b.bin"))
                        .as(type)
                        .isFalse();
            }
        }

        @Test
        void fallsBackToTheKeyWhenNothingWasDeclared() {
            // Older meetings and YouTube imports have no content type. The key
            // is the only evidence left, and it is the same evidence
            // ExportService.mediaExtension falls back to -- the two disagreeing
            // is how a file gets named .mp3 and never converted.
            assertThat(AudioDerivatives.isMp3(null, "meetings/u/m/audio.mp3")).isTrue();
            assertThat(AudioDerivatives.isMp3("", "meetings/u/m/audio.MP3")).isTrue();
            assertThat(AudioDerivatives.isMp3(null, "meetings/u/m/audio.webm")).isFalse();
            assertThat(AudioDerivatives.isMp3(null, null)).isFalse();
        }

        @Test
        void aDeclaredTypeBeatsAMisleadingName() {
            // Somebody uploading "recording.mp3" that is really a wav gets a
            // real conversion. The uploader's declaration is closer to the bytes
            // than a name anyone can type.
            assertThat(AudioDerivatives.isMp3("audio/wav", "meetings/u/m/recording.mp3")).isFalse();
        }
    }

    @Nested
    @DisplayName("where the converted copy goes")
    class Key {

        @Test
        void sitsBesideTheRecordingItCameFrom() {
            // Inside the meeting's own prefix, so any lifecycle rule or sweep
            // scoped to that prefix covers the derivative too -- including rules
            // written before this feature existed.
            assertThat(AudioDerivatives.mp3Key("meetings/usr_1/mtg_1/recording.webm"))
                    .isEqualTo("meetings/usr_1/mtg_1/recording.webm.mp3");
        }

        @Test
        void isTheSameEveryTime() {
            // The property the whole design rests on. Erasure recomputes this
            // months later from the original key alone; if it ever varied --
            // by timestamp, by request, by anything -- deleted recordings would
            // leave playable copies nobody could find.
            String key = "meetings/usr_1/mtg_1/a b.m4a";
            assertThat(AudioDerivatives.mp3Key(key)).isEqualTo(AudioDerivatives.mp3Key(key));
        }

        @Test
        void hasNothingToDeriveFromNothing() {
            // Callers read null as "there is no object here": nothing to
            // convert, and nothing to delete.
            assertThat(AudioDerivatives.mp3Key(null)).isNull();
            assertThat(AudioDerivatives.mp3Key("  ")).isNull();
        }
    }
}
