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

    /**
     * A patch of nulls, so each test names only the fields it is about.
     *
     * <p>Twenty positional nulls at every call site is how a transposition gets
     * written and never noticed — the record exists to be named, and these five
     * helpers are where the naming happens for tests.
     */
    private static UserService.PreferencesPatch profile(String displayName, String department,
                                                        String jobRole, String language) {
        return new UserService.PreferencesPatch(
                null, null, displayName, department, jobRole, language,
                null, null, null, null, null, null, null, null,
                null, null, null, null, null, null);
    }

    private static UserService.PreferencesPatch sharing(Boolean summary, Boolean actionItems,
                                                       Boolean transcript, Boolean audio,
                                                       Integer expiryDays, Boolean neverExpires) {
        return new UserService.PreferencesPatch(
                null, null, null, null, null, null,
                summary, actionItems, transcript, audio, expiryDays, neverExpires,
                null, null, null, null, null, null, null, null);
    }

    private static UserService.PreferencesPatch chatWindow(Integer days, Boolean everything) {
        return new UserService.PreferencesPatch(
                null, null, null, null, null, null,
                null, null, null, null, null, null, days, everything,
                null, null, null, null, null, null);
    }

    private static UserService.PreferencesPatch muting(List<String> kinds) {
        return new UserService.PreferencesPatch(
                null, null, null, null, null, null,
                null, null, null, null, null, null, null, null,
                null, null, null, null, null, kinds);
    }

    /** The V40 email switches: the digest cadence and the three around it. */
    private static UserService.PreferencesPatch email(Boolean taskReminders, Boolean digestWeekly,
                                                      Boolean emailsEnabled, Boolean recapForImports,
                                                      Boolean shareOpenedEmail) {
        return new UserService.PreferencesPatch(
                null, null, null, null, null, null,
                null, null, null, null, null, null, null, null,
                taskReminders, digestWeekly, emailsEnabled, recapForImports, shareOpenedEmail, null);
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
    class ShareDefaults {

        @Test
        @DisplayName("a new account shares notes and not the recording")
        void safeOutOfTheBox() {
            // The same defaults that were constants in ShareService. A
            // transcript is every word somebody said and a recording is their
            // voice; neither leaves an account because a box was pre-ticked.
            assertThat(user.isShareIncludeSummary()).isTrue();
            assertThat(user.isShareIncludeActionItems()).isTrue();
            assertThat(user.isShareIncludeTranscript()).isFalse();
            assertThat(user.isShareIncludeAudio()).isFalse();
            assertThat(user.getShareExpiryDays()).isNull();
        }

        @Test
        @DisplayName("each flag is set on its own")
        void flagsAreIndependent() {
            service.updatePreferences(USER, sharing(null, null, true, null, null, null));

            assertThat(user.isShareIncludeTranscript()).isTrue();
            assertThat(user.isShareIncludeSummary()).isTrue();
            assertThat(user.isShareIncludeAudio()).isFalse();
        }

        @Test
        @DisplayName("an expiry is stored in days")
        void expiryIsStored() {
            service.updatePreferences(USER, sharing(null, null, null, null, 30, null));

            assertThat(user.getShareExpiryDays()).isEqualTo(30);
        }

        @Test
        @DisplayName("never-expires needs its own flag, since absent means unchanged")
        void neverExpiresClears() {
            service.updatePreferences(USER, sharing(null, null, null, null, 30, null));

            service.updatePreferences(USER, sharing(null, null, null, null, null, true));

            // The same problem as removing a share password: an absent number
            // and an explicit "no expiry" arrive identically over JSON.
            assertThat(user.getShareExpiryDays()).isNull();
        }

        @Test
        @DisplayName("changing the flags leaves the expiry alone")
        void independentOfEachOther() {
            service.updatePreferences(USER, sharing(null, null, null, null, 7, null));

            service.updatePreferences(USER, sharing(false, null, null, null, null, null));

            assertThat(user.getShareExpiryDays()).isEqualTo(7);
            assertThat(user.isShareIncludeSummary()).isFalse();
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
     * The V40 email switches.
     *
     * <p>The one that needs guarding is the master. A master switch that cleared
     * the switches underneath it would turn "mute me for a fortnight" into a
     * one-way door: everything would come back off, and the person would have to
     * remember what they had chosen — which is exactly what nobody does.
     */
    @Nested
    class EmailSwitches {

        @Test
        @DisplayName("the master leaves every switch underneath it alone")
        void masterDoesNotRewriteTheRest() {
            user.setAutoEmailRecap(true);
            user.setRecapForImports(true);
            user.setTaskReminders(true);
            user.setShareOpenedEmail(true);

            service.updatePreferences(USER, email(null, null, false, null, null));

            assertThat(user.isEmailsEnabled()).isFalse();
            assertThat(user.isAutoEmailRecap()).isTrue();
            assertThat(user.isRecapForImports()).isTrue();
            assertThat(user.isTaskReminders()).isTrue();
            assertThat(user.isShareOpenedEmail()).isTrue();
        }

        @Test
        @DisplayName("each switch moves on its own")
        void switchesAreIndependent() {
            service.updatePreferences(USER, email(null, true, null, true, true));

            assertThat(user.isDigestWeekly()).isTrue();
            assertThat(user.isRecapForImports()).isTrue();
            assertThat(user.isShareOpenedEmail()).isTrue();
            // Untouched by a patch that did not mention it.
            assertThat(user.isTaskReminders()).isFalse();
        }

        @Test
        @DisplayName("an omitted switch is not a switch set to false")
        void omittedMeansUnchanged() {
            user.setShareOpenedEmail(true);
            user.setDigestWeekly(true);

            service.updatePreferences(USER, email(true, null, null, null, null));

            assertThat(user.isTaskReminders()).isTrue();
            assertThat(user.isShareOpenedEmail()).isTrue();
            assertThat(user.isDigestWeekly()).isTrue();
        }
    }
}
