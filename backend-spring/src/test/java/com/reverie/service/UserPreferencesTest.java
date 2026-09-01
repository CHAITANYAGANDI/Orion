package com.reverie.service;

import com.reverie.security.SelfOnlyAccess;
import com.reverie.common.ApiException;
import com.reverie.entity.UserEntity;
import com.reverie.repository.UserRepository;
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

    /**
     * A patch of nulls, so each test names only the fields it is about.
     *
     * <p>Positional nulls at every call site is how a transposition gets written
     * and never noticed — the record exists to be named, and these helpers are
     * where the naming happens for tests. `sharing` went with the share links
     * it configured; the mail switches came back in V64 with their own helper.
     */
    private static UserService.PreferencesPatch profile(String displayName, String department,
                                                        String jobRole, String language) {
        return new UserService.PreferencesPatch(
                displayName, department, jobRole,
                null, null, null,  // pronouns, email, avatarUrl -- their own helpers
                language,
                null, null, null,
                null, null, null, null, null);
    }

    /** Pronouns and the profile picture, which nothing else here touches. */
    private static UserService.PreferencesPatch person(String pronouns, String avatarUrl) {
        return new UserService.PreferencesPatch(
                null, null, null, pronouns, null, avatarUrl, null,
                null, null, null,
                null, null, null, null, null);
    }

    /** Just the account address. */
    private static UserService.PreferencesPatch address(String email) {
        return new UserService.PreferencesPatch(
                null, null, null, null, email, null, null,
                null, null, null,
                null, null, null, null, null);
    }

    private static UserService.PreferencesPatch chatWindow(Integer days, Boolean everything) {
        return new UserService.PreferencesPatch(
                null, null, null, null, null, null, null, days, everything, null,
                null, null, null, null, null);
    }

    private static UserService.PreferencesPatch muting(List<String> kinds) {
        return new UserService.PreferencesPatch(
                null, null, null, null, null, null, null, null, null, kinds,
                null, null, null, null, null);
    }

    /** Just the email switches, which nothing else here touches. */
    private static UserService.PreferencesPatch mailSwitches(Boolean warning, Boolean applied,
                                                             Boolean reminders, Boolean notes,
                                                             Boolean allowance) {
        return new UserService.PreferencesPatch(
                null, null, null, null, null, null, null, null, null, null,
                warning, applied, reminders, notes, allowance);
    }

    @BeforeEach
    void setUp() {
        service = new UserService(users, new SelfOnlyAccess(false, ""), "dev");
        user = new UserEntity();
        user.setId(USER);
        user.setClerkUserId("clerk_1");
        user.setDisplayName("Priya");
        when(users.findById(anyString())).thenAnswer(inv ->
                USER.equals(inv.getArgument(0)) ? Optional.of(user) : Optional.empty());
    }

    @Nested
    @DisplayName("the account address")
    class TheAddress {

        @Test
        @DisplayName("is editable when Reverie owns it")
        void editable() {
            service.updatePreferences(USER, address("  new@example.com  "));

            assertThat(user.getEmail()).isEqualTo("new@example.com");
        }

        @Test
        @DisplayName("cannot be emptied")
        void notCleared() {
            user.setEmail("old@example.com");

            assertThatThrownBy(() -> service.updatePreferences(USER, address("   ")))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("needs an email address");
        }

        @Test
        @DisplayName("is refused under an identity provider, rather than silently reverted")
        void refusedUnderProvider() {
            // `provision` rewrites this column from the sign-in token on the
            // very next request, so accepting the edit would be a control that
            // appeared to work and undid itself a second later.
            var clerk = new UserService(users, new SelfOnlyAccess(false, ""), "clerk");
            user.setEmail("old@example.com");

            assertThatThrownBy(() -> clerk.updatePreferences(USER, address("new@example.com")))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("managed by your sign-in provider");

            assertThat(user.getEmail()).isEqualTo("old@example.com");
        }

        @Test
        @DisplayName("resending the address unchanged is not an edit")
        void unchangedIsFine() {
            // The profile form sends every field it shows. Somebody renaming
            // themselves under a provider must not be told they cannot change
            // an address they never touched.
            var clerk = new UserService(users, new SelfOnlyAccess(false, ""), "clerk");
            user.setEmail("same@example.com");

            clerk.updatePreferences(USER, address("same@example.com"));

            assertThat(user.getEmail()).isEqualTo("same@example.com");
        }
    }

    @Nested
    @DisplayName("pronouns and the profile picture")
    class ThePerson {

        @Test
        @DisplayName("pronouns are stored as written, trimmed")
        void pronounsStored() {
            // Free text and no list: every fixed set is wrong for somebody, and
            // the field exists precisely so the product stops guessing.
            service.updatePreferences(USER, person("  they/them  ", null));

            assertThat(user.getPronouns()).isEqualTo("they/them");
        }

        @Test
        @DisplayName("blank clears them rather than storing an empty string")
        void pronounsCleared() {
            user.setPronouns("she/her");

            service.updatePreferences(USER, person("   ", null));

            assertThat(user.getPronouns()).isNull();
        }

        @Test
        @DisplayName("omitting a field leaves it alone")
        void omittedUnchanged() {
            user.setPronouns("he/him");
            user.setAvatarUrl(PNG);

            service.updatePreferences(USER, person(null, null));

            assertThat(user.getPronouns()).isEqualTo("he/him");
            assertThat(user.getAvatarUrl()).isEqualTo(PNG);
        }

        @Test
        @DisplayName("an inline image is stored")
        void avatarStored() {
            service.updatePreferences(USER, person(null, PNG));

            assertThat(user.getAvatarUrl()).isEqualTo(PNG);
        }

        @Test
        @DisplayName("blank removes the picture")
        void avatarCleared() {
            user.setAvatarUrl(PNG);

            service.updatePreferences(USER, person(null, ""));

            assertThat(user.getAvatarUrl()).isNull();
        }

        /**
         * The reason this field is validated at all.
         *
         * <p>It is rendered straight into an {@code <img src>}. A remote URL is
         * a tracking pixel that fires for every colleague who opens the page,
         * reporting their IP and the time they looked to a host the account
         * owner chose; {@code javascript:} and an SVG carrying a script are the
         * sharper versions of the same hole.
         */
        @org.junit.jupiter.params.ParameterizedTest
        @org.junit.jupiter.params.provider.ValueSource(strings = {
                "https://tracker.example.com/pixel.png",
                "http://tracker.example.com/pixel.png",
                "javascript:alert(1)",
                "data:text/html;base64,PHNjcmlwdD4=",
                "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=",
                "not a url at all",
        })
        @DisplayName("anything that is not an inline raster image is refused")
        void avatarRefused(String hostile) {
            assertThatThrownBy(() -> service.updatePreferences(USER, person(null, hostile)))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("not an image");

            assertThat(user.getAvatarUrl()).isNull();
        }

        private static final String PNG = "data:image/png;base64,iVBORw0KGgo=";
    }

    @Nested
    class TheDescriptiveFields {

        @Test
        @DisplayName("department and role are stored, trimmed")
        void stored() {
            service.updatePreferences(USER, profile(null, "  IT  ", " Individual contributor ", null));

            assertThat(user.getDepartment()).isEqualTo("IT");
            assertThat(user.getJobRole()).isEqualTo("Individual contributor");
        }

        @Test
        @DisplayName("blank clears them rather than storing an empty string")
        void blankClears() {
            service.updatePreferences(USER, profile(null, "IT", "IC", null));

            service.updatePreferences(USER, profile(null, "   ", "", null));

            // Null and "" would render identically and compare differently.
            assertThat(user.getDepartment()).isNull();
            assertThat(user.getJobRole()).isNull();
        }

        @Test
        @DisplayName("an omitted field is left alone")
        void omittedSurvives() {
            service.updatePreferences(USER, profile(null, "IT", "IC", null));

            service.updatePreferences(USER, profile("Priya Raman", null, null, null));

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
            service.updatePreferences(USER, profile(null, null, null, "es"));

            assertThat(user.getDefaultLanguage()).isEqualTo("es");
        }

        @Test
        @DisplayName("a regional or named form resolves to the same code")
        void normalises() {
            // Providers and pickers both send variations; one spelling reaches
            // the database or the same choice compares unequal to itself.
            service.updatePreferences(USER, profile(null, null, null, "pt-BR"));
            assertThat(user.getDefaultLanguage()).isEqualTo("pt");

            service.updatePreferences(USER, profile(null, null, null, "Japanese"));
            assertThat(user.getDefaultLanguage()).isEqualTo("ja");
        }

        @Test
        @DisplayName("a language transcription cannot do is refused, not ignored")
        void refusesUnsupported() {
            // Telugu is the example in Language's own comment: there is nothing
            // to translate because there is nothing to transcribe. Dropping it
            // quietly would leave the settings page showing a choice the
            // pipeline never received.
            assertThatThrownBy(() -> service.updatePreferences(USER, profile(null, null, null, "te")))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("te");

            assertThat(user.getDefaultLanguage()).isNull();
        }

        @Test
        @DisplayName("blank restores auto-detect")
        void blankDetects() {
            service.updatePreferences(USER, profile(null, null, null, "de"));

            service.updatePreferences(USER, profile(null, null, null, ""));

            // Null is what the worker reads as "detect", which is the behaviour
            // every account had before this setting existed.
            assertThat(user.getDefaultLanguage()).isNull();
        }

        @Test
        @DisplayName("omitting it leaves the choice alone")
        void omittedSurvives() {
            service.updatePreferences(USER, profile(null, null, null, "fr"));

            service.updatePreferences(USER, profile("Priya Raman", null, null, null));

            assertThat(user.getDefaultLanguage()).isEqualTo("fr");
        }
    }

    @Nested
    class ChatWindow {

        @Test
        @DisplayName("a new account lets chat read everything")
        void everythingByDefault() {
            assertThat(user.getChatHistoryDays()).isNull();
        }

        @Test
        @DisplayName("a window is stored in days")
        void storesTheWindow() {
            service.updatePreferences(USER, chatWindow(365, null));

            assertThat(user.getChatHistoryDays()).isEqualTo(365);
        }

        @Test
        @DisplayName("reading everything again needs its own flag")
        void clearing() {
            service.updatePreferences(USER, chatWindow(90, null));

            service.updatePreferences(USER, chatWindow(null, true));

            // Null is what the ai-service reads as "no floor", and an absent
            // number cannot say the difference between that and "leave it".
            assertThat(user.getChatHistoryDays()).isNull();
        }

        @Test
        @DisplayName("an unrelated change leaves the window alone")
        void survivesOtherEdits() {
            service.updatePreferences(USER, chatWindow(90, null));

            service.updatePreferences(USER, profile("Priya Raman", null, null, null));

            assertThat(user.getChatHistoryDays()).isEqualTo(90);
        }
    }

    @Nested
    class Muting {

        @Test
        @DisplayName("an unknown kind is dropped rather than stored")
        void dropsUnknown() {
            service.updatePreferences(USER, muting(List.of("SUMMARY_READY", "NOT_A_KIND")));

            // A string with no switch behind it is a mute nobody could undo.
            assertThat(user.getMutedNotifications()).containsExactly("SUMMARY_READY");
        }

        @Test
        @DisplayName("a kind that cannot be muted stays on")
        void keepsUnmutable() {
            service.updatePreferences(USER, muting(List.of("PROCESSING_FAILED", "RETENTION_APPLIED")));

            // Silence and "nothing happened" would be the same signal.
            assertThat(user.getMutedNotifications()).isEmpty();
        }
    }

    /**
     * Nothing here mails anybody.
     *
     * <p>Six switches used to live in this record — the recap, the recap for
     * imports, the master, the morning reminder, the Monday review, and the
     * comment and highlight notices. They were removed in V56 along with the
     * senders behind them: the settings tab that reached them was deleted from
     * the frontend, which left a subsystem nobody could turn on and nobody
     * could turn off.
     */
    @Test
    @DisplayName("the patch carries no way to ask for email")
    void noMailSwitchesSurvive() {
        var names = java.util.Arrays.stream(UserService.PreferencesPatch.class.getRecordComponents())
                .map(java.lang.reflect.RecordComponent::getName)
                .toList();

        assertThat(names).doesNotContain(
                "autoEmailRecap", "recapEmail", "recapForImports", "emailsEnabled",
                "taskReminders", "weeklyDigest", "commentEmail", "highlightEmail");
    }
}
