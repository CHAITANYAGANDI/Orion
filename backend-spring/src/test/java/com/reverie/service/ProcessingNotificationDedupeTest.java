package com.reverie.service;

import com.reverie.domain.NotificationKind;
import com.reverie.entity.Meeting;
import com.reverie.entity.Notification;
import com.reverie.entity.UserEntity;
import com.reverie.repository.NotificationRepository;
import com.reverie.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * One arrival, one bell — however many times the arrival is reported.
 *
 * <p>The notifications raised by the processing pipeline passed a null
 * dedupe key, which meant the unique index added in V34 —
 * {@code (user_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL} — did not
 * cover them. Redelivery of a result callback produced a second "Summary
 * ready".
 *
 * <p>The key is per event type <em>and</em> per processing attempt. Type,
 * because a failure must never be able to suppress a success. Attempt, because
 * a reprocess is entitled to announce itself again.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProcessingNotificationDedupeTest {

    private static final String USER = "usr_1";

    @Mock private NotificationRepository notifications;
    @Mock private UserRepository users;
    @Mock private NotificationPublisher publisher;

    private NotificationService service;
    private List<Notification> stored;

    @BeforeEach
    void setUp() {
        service = new NotificationService(notifications, users, publisher);

        UserEntity user = new UserEntity();
        user.setId(USER);
        user.setMutedNotifications(new ArrayList<>());
        when(users.findById(USER)).thenReturn(Optional.of(user));

        // A stand-in for uq_notifications_dedupe. `save` only lands when the
        // (kind, dedupe_key) pair is free, which is what the index enforces.
        stored = new ArrayList<>();
        Set<String> taken = new HashSet<>();
        when(notifications.save(any(Notification.class))).thenAnswer(i -> {
            Notification n = i.getArgument(0);
            if (n.getDedupeKey() != null && !taken.add(n.getKind() + "|" + n.getDedupeKey())) {
                throw new IllegalStateException("uq_notifications_dedupe");
            }
            stored.add(n);
            return n;
        });
        when(notifications.existsByUserIdAndKindAndDedupeKey(anyString(), any(), anyString()))
                .thenAnswer(i -> taken.contains(i.getArgument(1) + "|" + i.getArgument(2)));
    }

    private static Meeting meeting(int attempt) {
        Meeting m = new Meeting();
        m.setId("mtg_1");
        m.setUserId(USER);
        m.setTitle("Sprint planning");
        m.setProcessingAttempt(attempt);
        return m;
    }

    private long countOf(NotificationKind kind) {
        return stored.stream().filter(n -> n.getKind() == kind).count();
    }

    @Test
    @DisplayName("a summary-ready delivered twice is stored once")
    void summaryReadyIsIdempotent() {
        service.summaryReady(meeting(1), 1);
        service.summaryReady(meeting(1), 1);

        assertThat(countOf(NotificationKind.SUMMARY_READY)).isEqualTo(1);
    }

    @Test
    @DisplayName("a transcript-ready delivered twice is stored once")
    void transcriptReadyIsIdempotent() {
        service.transcriptReady(meeting(1), 1);
        service.transcriptReady(meeting(1), 1);

        assertThat(countOf(NotificationKind.TRANSCRIPT_READY)).isEqualTo(1);
    }

    @Test
    @DisplayName("a processing-failed delivered twice is stored once")
    void processingFailedIsIdempotent() {
        service.processingFailed(meeting(1), "the audio was unreadable", 1);
        service.processingFailed(meeting(1), "the audio was unreadable", 1);

        assertThat(countOf(NotificationKind.PROCESSING_FAILED)).isEqualTo(1);
    }

    @Test
    @DisplayName("different kinds about the same meeting all survive")
    void kindsDoNotSuppressEachOther() {
        // The reason the key names the event rather than being "meeting:{id}".
        // A shared key would let whichever arrived first silence the rest.
        Meeting m = meeting(1);
        service.transcriptReady(m, 1);
        service.summaryReady(m, 1);
        service.processingFailed(m, "something went wrong afterwards", 1);

        assertThat(countOf(NotificationKind.TRANSCRIPT_READY)).isEqualTo(1);
        assertThat(countOf(NotificationKind.SUMMARY_READY)).isEqualTo(1);
        assertThat(countOf(NotificationKind.PROCESSING_FAILED)).isEqualTo(1);
    }

    @Test
    @DisplayName("a reprocess announces itself again")
    void reprocessIsNotSuppressed() {
        service.summaryReady(meeting(1), 1);

        // reprocess() incremented processing_attempt, so this is a different
        // run and the user is entitled to hear about it.
        service.summaryReady(meeting(2), 2);

        assertThat(countOf(NotificationKind.SUMMARY_READY)).isEqualTo(2);
    }

    @Test
    @DisplayName("a redelivery of the first run is still suppressed after a reprocess")
    void staleRedeliveryStaysSuppressed() {
        service.summaryReady(meeting(1), 1);
        service.summaryReady(meeting(2), 2);

        service.summaryReady(meeting(1), 1);

        assertThat(countOf(NotificationKind.SUMMARY_READY)).isEqualTo(2);
    }

    @Test
    @DisplayName("the key names the event and the attempt, not just the meeting")
    void keyShape() {
        service.summaryReady(meeting(3), 3);

        assertThat(stored.get(0).getDedupeKey()).isEqualTo("summary-ready:mtg_1:3");
    }

    @Test
    @DisplayName("a constraint violation is absorbed rather than thrown at the caller")
    void raceDoesNotEscape() {
        // Two callbacks in flight together both pass the existence check and
        // both attempt the insert; the index refuses the second. That must not
        // surface as a failed callback.
        service.summaryReady(meeting(1), 1);
        stored.clear();

        service.summaryReady(meeting(1), 1);

        assertThat(stored).isEmpty();
    }
}
