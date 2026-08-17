package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.UserEntity;
import com.recallix.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * The account page's fields.
 *
 * <p>Three of them are descriptive — a name, a department, a role — and one is
 * not. {@code defaultLanguage} is sent with every transcription job, so the
 * failure it guards against is a transcript in a language nobody spoke: an
 * unsupported code accepted here would be silently dropped by the provider and
 * the settings page would go on showing a choice the pipeline never received.
 *
 * <p>The other half of these tests is the partial-update contract. Every field
 * is nullable and null means "leave it", which is what lets one switch be
 * flipped without the page resending the rest — and is exactly the rule a later
 * refactor breaks by treating blank and absent alike.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class UserPreferencesTest {

    private static final String USER = "usr_1";

    @Mock private UserRepository users;

    private UserService service;
    private UserEntity user;

    private static UserService.PreferencesPatch patch(String displayName, String department,
                                                      String jobRole, String language) {
        return new UserService.PreferencesPatch(
                null, null, displayName, department, jobRole, language, null, null);
    }

    @BeforeEach
    void setUp() {
        service = new UserService(users);
        user = new UserEntity();
        user.setId(USER);
        user.setClerkUserId("clerk_1");
        user.setDisplayName("Priya");
        when(users.findById(anyString())).thenAnswer(inv ->
                USER.equals(inv.getArgument(0)) ? Optional.of(user) : Optional.empty());
    }

    @Nested
    class TheDescriptiveFields {

        @Test
        @DisplayName("department and role are stored, trimmed")
        void stored() {
            service.updatePreferences(USER, patch(null, "  IT  ", " Individual contributor ", null));

            assertThat(user.getDepartment()).isEqualTo("IT");
            assertThat(user.getJobRole()).isEqualTo("Individual contributor");
        }

        @Test
        @DisplayName("blank clears them rather than storing an empty string")
        void blankClears() {
            service.updatePreferences(USER, patch(null, "IT", "IC", null));

            service.updatePreferences(USER, patch(null, "   ", "", null));

            // Null and "" would render identically and compare differently.
            assertThat(user.getDepartment()).isNull();
            assertThat(user.getJobRole()).isNull();
        }

        @Test
        @DisplayName("an omitted field is left alone")
        void omittedSurvives() {
            service.updatePreferences(USER, patch(null, "IT", "IC", null));

            service.updatePreferences(USER, patch("Priya Raman", null, null, null));

            // The account block saves three fields at once; a rename that also
            // wiped the other two would be a rename nobody asked for.
            assertThat(user.getDisplayName()).isEqualTo("Priya Raman");
            assertThat(user.getDepartment()).isEqualTo("IT");
            assertThat(user.getJobRole()).isEqualTo("IC");
        }
    }

    @Nested
    class TheLanguage {

        @Test
        @DisplayName("a supported language is stored as its bare code")
        void storesTheCode() {
            service.updatePreferences(USER, patch(null, null, null, "es"));

            assertThat(user.getDefaultLanguage()).isEqualTo("es");
        }

        @Test
        @DisplayName("a regional or named form resolves to the same code")
        void normalises() {
            // Providers and pickers both send variations; one spelling reaches
            // the database or the same choice compares unequal to itself.
            service.updatePreferences(USER, patch(null, null, null, "pt-BR"));
            assertThat(user.getDefaultLanguage()).isEqualTo("pt");

            service.updatePreferences(USER, patch(null, null, null, "Japanese"));
            assertThat(user.getDefaultLanguage()).isEqualTo("ja");
        }

        @Test
        @DisplayName("a language transcription cannot do is refused, not ignored")
        void refusesUnsupported() {
            // Telugu is the example in Language's own comment: there is nothing
            // to translate because there is nothing to transcribe. Dropping it
            // quietly would leave the settings page showing a choice the
            // pipeline never received.
            assertThatThrownBy(() -> service.updatePreferences(USER, patch(null, null, null, "te")))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("te");

            assertThat(user.getDefaultLanguage()).isNull();
        }

        @Test
        @DisplayName("blank restores auto-detect")
        void blankDetects() {
            service.updatePreferences(USER, patch(null, null, null, "de"));

            service.updatePreferences(USER, patch(null, null, null, ""));

            // Null is what the worker reads as "detect", which is the behaviour
            // every account had before this setting existed.
            assertThat(user.getDefaultLanguage()).isNull();
        }

        @Test
        @DisplayName("omitting it leaves the choice alone")
        void omittedSurvives() {
            service.updatePreferences(USER, patch(null, null, null, "fr"));

            service.updatePreferences(USER, patch("Priya Raman", null, null, null));

            assertThat(user.getDefaultLanguage()).isEqualTo("fr");
        }
    }

    @Nested
    class Muting {

        @Test
        @DisplayName("an unknown kind is dropped rather than stored")
        void dropsUnknown() {
            service.updatePreferences(USER, new UserService.PreferencesPatch(
                    null, null, null, null, null, null, null,
                    List.of("SUMMARY_READY", "NOT_A_KIND")));

            // A string with no switch behind it is a mute nobody could undo.
            assertThat(user.getMutedNotifications()).containsExactly("SUMMARY_READY");
        }

        @Test
        @DisplayName("a kind that cannot be muted stays on")
        void keepsUnmutable() {
            service.updatePreferences(USER, new UserService.PreferencesPatch(
                    null, null, null, null, null, null, null,
                    List.of("PROCESSING_FAILED", "RETENTION_APPLIED")));

            // Silence and "nothing happened" would be the same signal.
            assertThat(user.getMutedNotifications()).isEmpty();
        }
    }
}
