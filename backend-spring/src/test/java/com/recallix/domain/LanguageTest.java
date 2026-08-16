package com.recallix.domain;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.Set;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The languages Recallix works in.
 *
 * <p>This list is a boundary of the product rather than a preference: audio in a
 * language the transcription model does not support cannot be transcribed at
 * all, and no amount of translation afterwards recovers it. The tests are
 * therefore about the list being exactly what it claims to be, and about the
 * lookup being forgiving enough that a provider's {@code en_us} and a user's
 * "Spanish" both land on the same row.
 */
class LanguageTest {

    @Test
    @DisplayName("eighteen languages, matching what the transcription model supports")
    void theListIsTheSupportedOne() {
        assertThat(Language.all()).hasSize(18);
    }

    @Test
    @DisplayName("no two share a code")
    void codesAreUnique() {
        // A duplicate would make one of them unreachable through find(), and
        // the unreachable one would silently never be offered.
        Set<String> codes = Language.all().stream()
                .map(Language::code).collect(Collectors.toSet());

        assertThat(codes).hasSize(Language.all().size());
    }

    @Test
    @DisplayName("every entry has a code, an English name and an endonym")
    void everyEntryIsComplete() {
        assertThat(Language.all()).allSatisfy(l -> {
            assertThat(l.code()).hasSize(2);
            assertThat(l.englishName()).isNotBlank();
            // Shown beside the English name: somebody looking for their own
            // language scans for 日本語 faster than for "Japanese".
            assertThat(l.nativeName()).isNotBlank();
        });
    }

    @ParameterizedTest
    @ValueSource(strings = {"es", "ES", "Spanish", "spanish", "Español", " es "})
    @DisplayName("a language is found by code, by name, or by its own name")
    void findsEveryWayItMightBeWritten(String raw) {
        assertThat(Language.find(raw)).contains(Language.SPANISH);
    }

    @ParameterizedTest
    @ValueSource(strings = {"en_us", "en-GB", "en_UK"})
    @DisplayName("a regional suffix is dropped rather than refused")
    void toleratesRegionalCodes(String raw) {
        // Providers return these. Refusing them would leave a meeting's own
        // detected language failing every lookup that reads it.
        assertThat(Language.find(raw)).contains(Language.ENGLISH);
    }

    @Test
    @DisplayName("a language we cannot work in is not found")
    void refusesTheUnsupported() {
        // Telugu is the example that matters: it is a language people hold
        // meetings in and the transcription model does not support it, so
        // pretending otherwise would promise a transcript that cannot exist.
        assertThat(Language.find("te")).isEmpty();
        assertThat(Language.find("Telugu")).isEmpty();
        assertThat(Language.find("Klingon")).isEmpty();
        assertThat(Language.find("")).isEmpty();
        assertThat(Language.find(null)).isEmpty();
    }

    @Test
    @DisplayName("right-to-left is recorded, because a pane has to set a direction")
    void marksRightToLeft() {
        assertThat(Language.ARABIC.rightToLeft()).isTrue();
        assertThat(Language.HEBREW.rightToLeft()).isTrue();
        assertThat(Language.all().stream().filter(Language::rightToLeft)).hasSize(2);
    }

    @Test
    @DisplayName("a label falls back to whatever it was given")
    void labelsUnknownCodesAsThemselves() {
        // Used for a meeting's detected language, which the provider may report
        // as something outside this list. A label is a label; showing the raw
        // code is better than showing nothing or guessing.
        assertThat(Language.label("ja")).isEqualTo("Japanese");
        assertThat(Language.label("te")).isEqualTo("te");
        assertThat(Language.label(null)).isNull();
    }
}
