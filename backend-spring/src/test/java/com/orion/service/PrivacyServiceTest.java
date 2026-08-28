package com.orion.service;

import com.orion.common.ApiException;
import com.orion.dto.PrivacyOverviewResponse;
import com.orion.entity.Meeting;
import com.orion.entity.UserEntity;
import com.orion.repository.ChatConversationRepository;
import com.orion.repository.MeetingActionItemRepository;
import com.orion.repository.MeetingRepository;
import com.orion.repository.ProjectRepository;
import com.orion.repository.TranscriptMomentRepository;
import com.orion.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The page that has to be true.
 *
 * <p>Two things are being tested here and they pull in opposite directions.
 * One is that the page reports reality rather than intentions — most sharply
 * that "encrypted storage" comes back from the object store and is allowed to
 * say no. The other is that the irreversible button is hard to press by
 * accident and does exactly what it says once pressed.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class PrivacyServiceTest {

    private static final String USER = "usr_1";
    private static final LocalDate TODAY = LocalDate.of(2026, 8, 16);

    @Mock private MeetingRepository meetings;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private TranscriptMomentRepository moments;
    @Mock private ProjectRepository projects;
    @Mock private ChatConversationRepository conversations;
    @Mock private UserRepository users;
    @Mock private RetentionService retention;
    @Mock private ErasureService erasure;
    @Mock private StorageService storage;
    @Mock private AuditService audit;

    private PrivacyService service;
    private UserEntity user;

    @BeforeEach
    void setUp() {
        service = new PrivacyService(meetings, actionItems, moments, projects, conversations,
                users, retention, erasure, storage, audit, "https://orion.test/");
        user = new UserEntity();
        user.setId(USER);
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(List.of());
        when(retention.preview(anyString(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(new RetentionService.Due(0, 0));
        when(storage.encryptionAtRest()).thenReturn(Optional.empty());
        when(storage.presignExpirySeconds()).thenReturn(900L);
    }

    private static Meeting meeting(String id, String title) {
        Meeting meeting = new Meeting();
        meeting.setId(id);
        meeting.setUserId(USER);
        meeting.setTitle(title);
        meeting.setObjectKey("meetings/usr_1/" + id + "/audio.mp3");
        meeting.setCreatedAt(Instant.parse("2026-01-01T09:00:00Z"));
        return meeting;
    }

    @Nested
    @DisplayName("what is held")
    class Inventory {

        @Test
        @DisplayName("separates recordings still here from recordings already erased")
        void countsErasures() {
            Meeting kept = meeting("mtg_1", "Sprint planning");
            Meeting stripped = meeting("mtg_2", "One-to-one");
            stripped.setObjectKey(null);
            stripped.setAudioDeletedAt(Instant.parse("2026-06-01T09:00:00Z"));
            stripped.setTranscriptDeletedAt(Instant.parse("2026-06-01T09:00:00Z"));
            when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(List.of(kept, stripped));

            PrivacyOverviewResponse.Held held = service.overview(USER, TODAY).held();

            assertThat(held.meetings()).isEqualTo(2);
            assertThat(held.recordings()).isEqualTo(1);
            assertThat(held.audioErased()).isEqualTo(1);
            assertThat(held.transcripts()).isEqualTo(1);
            assertThat(held.transcriptsErased()).isEqualTo(1);
        }

        @Test
        @DisplayName("counts only the meetings whose recorder confirmed the room was told")
        void countsConsent() {
            Meeting recorded = meeting("mtg_1", "Standup");
            recorded.setConsentConfirmedAt(Instant.parse("2026-02-02T09:00:00Z"));
            when(meetings.findByUserIdOrderByCreatedAtDesc(USER))
                    .thenReturn(List.of(recorded, meeting("mtg_2", "Uploaded file")));

            assertThat(service.overview(USER, TODAY).held().consentConfirmed()).isEqualTo(1);
        }

        @Test
        @DisplayName("reports the oldest thing it has, which is what a retention dial acts on first")
        void reportsTheOldest() {
            Meeting older = meeting("mtg_1", "First ever");
            older.setCreatedAt(Instant.parse("2025-03-04T09:00:00Z"));
            when(meetings.findByUserIdOrderByCreatedAtDesc(USER))
                    .thenReturn(List.of(meeting("mtg_2", "Recent"), older));

            assertThat(service.overview(USER, TODAY).held().oldestMeetingAt())
                    .isEqualTo(Instant.parse("2025-03-04T09:00:00Z"));
        }
    }

    @Nested
    @DisplayName("how it is stored")
    class Storage {

        @Test
        @DisplayName("says nothing about encryption when the bucket applies none")
        void doesNotClaimWhatIsNotTrue() {
            when(storage.encryptionAtRest()).thenReturn(Optional.empty());

            assertThat(service.overview(USER, TODAY).storage().encryptionAtRest()).isNull();
        }

        @Test
        @DisplayName("repeats what the bucket actually reports")
        void repeatsTheBucket() {
            when(storage.encryptionAtRest()).thenReturn(Optional.of("AES256"));

            PrivacyOverviewResponse.StorageFacts facts = service.overview(USER, TODAY).storage();

            assertThat(facts.encryptionAtRest()).isEqualTo("AES256");
            assertThat(facts.signedUrlSeconds()).isEqualTo(900L);
            assertThat(facts.rowLevelSecurity()).isTrue();
        }
    }

    @Nested
    @DisplayName("closing the account")
    class Closing {

        @Test
        @DisplayName("refuses anything but the phrase")
        void refusesTheWrongWords() {
            assertThatThrownBy(() -> service.closeAccount(USER, "yes"))
                    .isInstanceOf(ApiException.class)
                    .hasMessageContaining("delete everything");
            assertThatThrownBy(() -> service.closeAccount(USER, null))
                    .isInstanceOf(ApiException.class);
            verify(erasure, never()).eraseAccount(anyString());
        }

        @Test
        @DisplayName("accepts the phrase whatever the spacing and case")
        void toleratesTypingHabits() {
            when(meetings.countByUserId(USER)).thenReturn(3L);
            when(erasure.eraseAccount(USER)).thenReturn(3);

            PrivacyService.Closed closed = service.closeAccount(USER, "  Delete Everything  ");

            assertThat(closed.meetings()).isEqualTo(3);
            assertThat(closed.storedObjects()).isEqualTo(3);
        }

        @Test
        @DisplayName("counts what was there before it goes, since afterwards nothing can be counted")
        void countsBeforeDeleting() {
            when(meetings.countByUserId(USER)).thenReturn(12L);
            when(erasure.eraseAccount(USER)).thenReturn(9);

            var order = org.mockito.Mockito.inOrder(meetings, erasure);
            service.closeAccount(USER, "delete everything");

            order.verify(meetings).countByUserId(USER);
            order.verify(erasure).eraseAccount(USER);
        }
    }

    @Nested
    @DisplayName("retention on the page")
    class Retention {

        @Test
        @DisplayName("shows both dials with what they would take tonight")
        void showsThePreview() {
            user.setAudioRetentionDays(30);
            user.setMeetingRetentionDays(365);
            when(retention.preview(USER, 30, 365, TODAY)).thenReturn(new RetentionService.Due(4, 1));

            PrivacyOverviewResponse.Retention shown = service.overview(USER, TODAY).retention();

            assertThat(shown.audioDays()).isEqualTo(30);
            assertThat(shown.meetingDays()).isEqualTo(365);
            assertThat(shown.recordingsDueNow()).isEqualTo(4);
            assertThat(shown.meetingsDueNow()).isEqualTo(1);
        }

        @Test
        @DisplayName("answers a change with what the new policy would do, not the old one")
        void previewsTheNewPolicy() {
            UserEntity updated = new UserEntity();
            updated.setId(USER);
            updated.setAudioRetentionDays(7);
            when(retention.setPolicy(USER, 7, null)).thenReturn(updated);
            when(retention.preview(USER, 7, null, TODAY)).thenReturn(new RetentionService.Due(11, 0));

            PrivacyOverviewResponse.Retention shown = service.setRetention(USER, 7, null, TODAY);

            assertThat(shown.audioDays()).isEqualTo(7);
            assertThat(shown.recordingsDueNow()).isEqualTo(11);
        }
    }

    @Nested
    @DisplayName("the clock")
    class Clock {

        @Test
        @DisplayName("is UTC, the same one every scheduled thing already agrees on")
        void isUtc() {
            assertThat(PrivacyService.todayUtc()).isEqualTo(LocalDate.now(ZoneOffset.UTC));
        }
    }
}
