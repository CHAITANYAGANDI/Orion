package com.recallix.service;

import com.recallix.common.ApiException;
import com.recallix.entity.SpeakerProfile;
import com.recallix.entity.UserEntity;
import com.recallix.repository.SpeakerProfileRepository;
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
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Consent, isolation and deletion for voice templates.
 *
 * <p>These are the tests that have to pass for the feature to be allowed to
 * exist. An ECAPA embedding is a stable identifier derived from a person's body
 * and is what makes one recording of them linkable to every other; under GDPR
 * Article 9 a template used to identify a natural person is biometric data. So
 * "it works" is not sufficient — it has to be off until asked for, confined to
 * one account, visible to the person who owns it, and removable.
 *
 * <p>The five rules being tested are written out in
 * {@code V53__speaker_profiles.sql}. What follows is the enforcement.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SpeakerProfilePrivacyTest {

    private static final String USER = "usr_1";
    private static final String OTHER = "usr_2";

    @Mock private UserRepository users;
    @Mock private SpeakerProfileRepository profiles;
    @Mock private AiClient ai;
    @Mock private AuditService audit;

    private SpeakerIdentityService service;
    private UserEntity user;
    private SpeakerProfile sarah;

    @BeforeEach
    void setUp() {
        service = new SpeakerIdentityService(users, profiles, ai, audit);

        user = new UserEntity();
        user.setId(USER);

        sarah = new SpeakerProfile();
        sarah.setId("spf_1");
        sarah.setUserId(USER);
        sarah.setDisplayName("Sarah");
        sarah.setSampleCount(3);

        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(users.findById(OTHER)).thenReturn(Optional.empty());
        when(profiles.findByUserIdOrderByUpdatedAtDesc(USER)).thenReturn(List.of(sarah));
        when(profiles.findByIdAndUserId("spf_1", USER)).thenReturn(Optional.of(sarah));
        when(profiles.findByIdAndUserId("spf_1", OTHER)).thenReturn(Optional.empty());
    }

    @Nested
    @DisplayName("14a. off until asked for")
    class Consent {

        @Test
        @DisplayName("a new account has voice learning switched off")
        void offByDefault() {
            // Not a default that could drift: `speaker_learning_enabled` is
            // NOT NULL DEFAULT FALSE in V53, so every account that existed when
            // the migration ran has it off too. Nobody is opted in by a deploy.
            assertThat(new UserEntity().isSpeakerLearningEnabled()).isFalse();
            assertThat(service.learningEnabled(USER)).isFalse();
        }

        @Test
        @DisplayName("an account that does not exist is not opted in either")
        void unknownAccountIsOff() {
            assertThat(service.learningEnabled(OTHER)).isFalse();
        }

        @Test
        @DisplayName("turning it on stores nothing by itself")
        void turningOnIsNotEnrolment() {
            service.setLearningEnabled(USER, true);

            assertThat(user.isSpeakerLearningEnabled()).isTrue();
            // A profile appears the first time somebody is named, which is the
            // act that means "this voice is this person". Enrolling in the
            // background off the back of a switch would be enrolling everyone
            // who has ever been in one of your meetings.
            verify(ai, never()).learnSpeaker(anyString(), anyString(), any(), anyString(),
                    anyString(), any());
        }
    }

    @Nested
    @DisplayName("14b. off means deleted, not paused")
    class Withdrawal {

        @Test
        @DisplayName("switching it off erases every profile and every voiceprint")
        void offDeletesEverything() {
            user.setSpeakerLearningEnabled(true);

            service.setLearningEnabled(USER, false);

            // Both nulls: no profile id and no meeting id means "everything this
            // account holds". A switch that only stopped new learning would leave
            // the templates in place, which is not what "off" means to the person
            // reading it.
            verify(ai).forgetSpeakers(eq(USER), isNull(), isNull());
            verify(profiles).deleteByUserId(USER);
            assertThat(user.isSpeakerLearningEnabled()).isFalse();
        }

        @Test
        @DisplayName("a failed erasure leaves the switch visibly on rather than claiming success")
        void aFailedDeletionDoesNotFlipTheSwitch() {
            user.setSpeakerLearningEnabled(true);
            doThrow(new RuntimeException("ai-service down"))
                    .when(ai).forgetSpeakers(eq(USER), isNull(), isNull());

            assertThat(catchThrowable(() -> service.setLearningEnabled(USER, false)))
                    .isInstanceOf(RuntimeException.class);

            // The one outcome a deletion must never have is a success message
            // over data that is still there.
            assertThat(user.isSpeakerLearningEnabled()).isTrue();
        }

        @Test
        @DisplayName("setting it to the value it already has does nothing at all")
        void idempotent() {
            user.setSpeakerLearningEnabled(false);

            service.setLearningEnabled(USER, false);

            // Not a no-op for tidiness: without it, a settings page that
            // re-sends its state would delete every profile on each save.
            verify(ai, never()).forgetSpeakers(anyString(), any(), any());
            verify(profiles, never()).deleteByUserId(anyString());
        }
    }

    @Nested
    @DisplayName("14c. removing one voice")
    class DeleteOne {

        @Test
        @DisplayName("deletes it at the far end, where the vector actually lives")
        void deletesTheTemplate() {
            service.deleteProfile(USER, "spf_1");

            verify(ai).forgetSpeakers(eq(USER), eq("spf_1"), isNull());
        }

        @Test
        @DisplayName("another account cannot delete it, and gets a 404 rather than a 403")
        void notYours() {
            assertThat(catchThrowable(() -> service.deleteProfile(OTHER, "spf_1")))
                    .isInstanceOf(ApiException.class);
            // Not found, not forbidden: confirming that a profile exists but
            // belongs to somebody else is itself a small leak.
            verify(ai, never()).forgetSpeakers(anyString(), anyString(), any());
        }

        @Test
        @DisplayName("a missing profile is a 404, not a silent success")
        void unknownProfile() {
            when(profiles.findByIdAndUserId("spf_9", USER)).thenReturn(Optional.empty());

            assertThat(catchThrowable(() -> service.deleteProfile(USER, "spf_9")))
                    .isInstanceOf(ApiException.class);
        }
    }

    @Nested
    @DisplayName("13. one account's voices")
    class Isolation {

        @Test
        @DisplayName("listing is scoped to the caller")
        void listIsScoped() {
            assertThat(service.list(USER)).extracting("name").containsExactly("Sarah");

            verify(profiles).findByUserIdOrderByUpdatedAtDesc(USER);
            // There is no findAll, no findByName, and no repository method that
            // takes an id without a user. A method shaped like that is the one
            // that eventually gets called from somewhere that forgot to check.
            verify(profiles, never()).findAll();
        }

        @Test
        @DisplayName("nothing about the vector reaches the response")
        void noEmbeddingOnTheWire() {
            var response = service.list(USER).get(0);

            assertThat(response.name()).isEqualTo("Sarah");
            assertThat(response.samples()).isEqualTo(3);
            // Enforced by absence rather than discipline: `embedding` is not
            // mapped on the entity at all, so there is no field here that could
            // be added to this record by accident.
            assertThat(SpeakerProfile.class.getDeclaredFields())
                    .extracting("name")
                    .doesNotContain("embedding");
        }
    }

    @Nested
    @DisplayName("erasure reaches derived data too")
    class Erasure {

        @Test
        @DisplayName("erasing a recording erases the voiceprints taken from it")
        void audioErasureTakesVoiceprints() {
            service.forgetMeeting(USER, "mtg_1");

            // An embedding is not audio and cannot be turned back into it, which
            // is the argument for keeping it. It should not be kept: it is a
            // durable identifier built from the voices on that recording, and
            // holding one after "delete the recording of me" is a technicality.
            verify(ai).forgetSpeakers(eq(USER), isNull(), eq("mtg_1"));
        }

        @Test
        @DisplayName("but leaves the named profiles, which were a separate decision")
        void namedProfilesSurviveAnAudioErasure() {
            service.forgetMeeting(USER, "mtg_1");

            verify(profiles, never()).deleteByUserId(anyString());
        }

        @Test
        @DisplayName("closing an account erases everything and cannot be blocked by a failure")
        void accountClosureAlwaysFinishes() {
            doThrow(new RuntimeException("ai-service down"))
                    .when(ai).forgetSpeakers(eq(USER), isNull(), isNull());

            service.forgetEverything(USER);

            // Unlike the settings toggle, this one must not throw: an account
            // closure that stalls half-way leaves the user with an account they
            // asked to be rid of. The rows go with the user row regardless —
            // both tables are ON DELETE CASCADE from `users`.
            verify(profiles).deleteByUserId(USER);
        }
    }
}
