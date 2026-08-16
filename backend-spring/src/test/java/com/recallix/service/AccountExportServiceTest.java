package com.recallix.service;

import com.recallix.domain.ExportFormat;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingShare;
import com.recallix.entity.UserEntity;
import com.recallix.export.ExportFile;
import com.recallix.repository.KnownSpeakerRepository;
import com.recallix.repository.MeetingActionItemRepository;
import com.recallix.repository.MeetingInsightRepository;
import com.recallix.repository.MeetingRepository;
import com.recallix.repository.MeetingShareRepository;
import com.recallix.repository.MeetingSummaryRepository;
import com.recallix.repository.ProjectRepository;
import com.recallix.repository.TranscriptMomentRepository;
import com.recallix.repository.TranscriptSegmentRepository;
import com.recallix.repository.UserRepository;
import com.recallix.repository.VocabularyTermRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * Taking the whole account with you.
 *
 * <p>An export is judged on two things: whether it is complete, and whether it
 * is safe to leave in a downloads folder. So these tests read the archive back
 * and check both — that the meeting is in there twice, once for a machine and
 * once for a person, and that the one credential in the schema did not come
 * along for the ride.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AccountExportServiceTest {

    private static final String USER = "usr_1";

    @Mock private MeetingRepository meetings;
    @Mock private MeetingSummaryRepository summaries;
    @Mock private MeetingActionItemRepository actionItems;
    @Mock private TranscriptSegmentRepository segments;
    @Mock private TranscriptMomentRepository moments;
    @Mock private MeetingInsightRepository insights;
    @Mock private MeetingShareRepository shares;
    @Mock private ProjectRepository projects;
    @Mock private VocabularyTermRepository vocabulary;
    @Mock private KnownSpeakerRepository speakers;
    @Mock private UserRepository users;
    @Mock private ExportService exports;

    private AccountExportService service;
    private Meeting meeting;

    @BeforeEach
    void setUp() {
        service = new AccountExportService(meetings, summaries, actionItems, segments, moments,
                insights, shares, projects, vocabulary, speakers, users, exports);

        UserEntity user = new UserEntity();
        user.setId(USER);
        user.setEmail("priya@example.com");
        user.setDisplayName("Priya");
        user.setAudioRetentionDays(30);
        user.setMutedNotifications(new ArrayList<>(List.of("RECAP_SENT")));
        when(users.findById(USER)).thenReturn(Optional.of(user));

        meeting = new Meeting();
        meeting.setId("mtg_1");
        meeting.setUserId(USER);
        meeting.setTitle("Sprint planning");
        meeting.setCreatedAt(Instant.parse("2026-05-04T09:00:00Z"));
        when(meetings.findByUserIdOrderByCreatedAtDesc(USER)).thenReturn(List.of(meeting));

        when(summaries.findFirstByMeetingIdOrderByCreatedAtDesc(anyString())).thenReturn(Optional.empty());
        when(actionItems.findByMeetingId(anyString())).thenReturn(List.of());
        when(insights.findByMeetingIdOrderByCreatedAt(anyString())).thenReturn(List.of());
        when(moments.findByMeetingIdOrderByStartSecondsAscCreatedAtAsc(anyString())).thenReturn(List.of());
        when(segments.findByMeetingIdOrderByStartTimeAsc(anyString())).thenReturn(List.of());
        when(shares.findByUserIdAndRevokedFalseOrderByCreatedAtDesc(USER)).thenReturn(List.of());
        when(projects.findByUserIdOrderByFavoriteDescNameAsc(USER)).thenReturn(List.of());
        when(vocabulary.findByUserIdOrderByCategoryAscTermAsc(USER)).thenReturn(List.of());
        when(speakers.findByUserIdOrderByTimesUsedDescLastUsedAtDesc(USER)).thenReturn(List.of());
        when(exports.render(anyString(), anyString(), any(ExportFormat.class), anyBoolean(), any(), any()))
                .thenReturn(new ExportFile("sprint-planning.md", "text/markdown",
                        "# Sprint planning\n".getBytes(StandardCharsets.UTF_8)));
    }

    /** Every entry in the archive, path to contents. */
    private static Map<String, String> unzip(byte[] archive) throws IOException {
        Map<String, String> entries = new LinkedHashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archive), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                entries.put(entry.getName(), new String(zip.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        return entries;
    }

    private Map<String, String> archive() throws IOException {
        return unzip(service.build(USER, "UTC").content());
    }

    @Nested
    @DisplayName("what is in the file")
    class Contents {

        @Test
        @DisplayName("is named after the day it was taken")
        void isNamedByDate() {
            ExportFile file = service.build(USER, "UTC");

            assertThat(file.filename()).isEqualTo("recallix-export-" + LocalDate.now(java.time.ZoneOffset.UTC) + ".zip");
            assertThat(file.mediaType()).isEqualTo("application/zip");
        }

        @Test
        @DisplayName("carries the four top-level files a reader is promised")
        void hasEverySection() throws IOException {
            assertThat(archive()).containsKeys(
                    "README.txt", "account.json", "meetings.json", "action-items.csv");
        }

        @Test
        @DisplayName("writes each meeting twice: once for a machine, once for a person")
        void hasBothCopies() throws IOException {
            Map<String, String> entries = archive();

            assertThat(entries.get("meetings.json")).contains("Sprint planning");
            assertThat(entries).containsKey("meetings/sprint-planning-mtg_1/notes.md");
            assertThat(entries.get("meetings/sprint-planning-mtg_1/notes.md")).contains("# Sprint planning");
        }

        @Test
        @DisplayName("keeps the account's own settings, including its retention policy")
        void hasTheAccount() throws IOException {
            String account = archive().get("account.json");

            assertThat(account).contains("priya@example.com");
            assertThat(account).contains("\"audioDays\" : 30");
            assertThat(account).contains("RECAP_SENT");
        }

        @Test
        @DisplayName("says what it does not contain, rather than leaving it to be discovered")
        void readmeNamesTheOmission() throws IOException {
            String readme = archive().get("README.txt");

            assertThat(readme).contains("recordings");
            assertThat(readme).contains("1 meeting(s)");
        }
    }

    @Nested
    @DisplayName("what is deliberately left out")
    class Omissions {

        @Test
        @DisplayName("a share link's password hash never leaves the database")
        void noPasswordHash() throws IOException {
            MeetingShare protectedLink = new MeetingShare();
            protectedLink.setId("shr_1");
            protectedLink.setMeetingId("mtg_1");
            protectedLink.setUserId(USER);
            protectedLink.setToken("tok");
            protectedLink.setPasswordHash("$2a$10$averyrealbcrypthashgoeshere");
            when(shares.findByUserIdAndRevokedFalseOrderByCreatedAtDesc(USER))
                    .thenReturn(List.of(protectedLink));

            String account = archive().get("account.json");

            assertThat(account).doesNotContain("$2a$10$");
            assertThat(account).doesNotContain("passwordHash");
            // The fact that it is protected is worth keeping; the credential is not.
            assertThat(account).contains("\"passwordProtected\" : true");
        }
    }

    @Nested
    @DisplayName("the spreadsheet")
    class Csv {

        @Test
        @DisplayName("names the meeting each commitment came from")
        void carriesContext() throws IOException {
            MeetingActionItem item = new MeetingActionItem();
            item.setId("ai_1");
            item.setMeetingId("mtg_1");
            item.setTitle("Finish the JWT validation");
            item.setOwnerName("Priya");
            item.setDueOn(LocalDate.of(2026, 5, 8));
            item.setPriority("high");
            item.setStatus("OPEN");
            when(actionItems.findByMeetingId("mtg_1")).thenReturn(List.of(item));

            String csv = archive().get("action-items.csv");

            assertThat(csv).startsWith("meeting,task,owner,due,priority,status\n");
            assertThat(csv).contains(
                    "\"Sprint planning\",\"Finish the JWT validation\",\"Priya\",\"2026-05-08\",\"high\",\"OPEN\"");
        }

        @Test
        @DisplayName("survives a task title with a comma and a quotation mark in it")
        void escapesProperly() throws IOException {
            MeetingActionItem awkward = new MeetingActionItem();
            awkward.setId("ai_1");
            awkward.setMeetingId("mtg_1");
            awkward.setTitle("Ask Marcus, then \"confirm\" it");
            awkward.setStatus("OPEN");
            when(actionItems.findByMeetingId("mtg_1")).thenReturn(List.of(awkward));

            assertThat(archive().get("action-items.csv"))
                    .contains("\"Ask Marcus, then \"\"confirm\"\" it\"");
        }
    }

    @Nested
    @DisplayName("when part of it will not render")
    class Partial {

        @Test
        @DisplayName("one broken meeting does not cost somebody the other forty-nine")
        void keepsGoing() throws IOException {
            when(exports.render(anyString(), anyString(), any(ExportFormat.class), anyBoolean(), any(), any()))
                    .thenThrow(new IllegalStateException("renderer exploded"));

            Map<String, String> entries = archive();

            assertThat(entries).containsKey("meetings/sprint-planning-mtg_1/notes-unavailable.txt");
            assertThat(entries.get("meetings/sprint-planning-mtg_1/notes-unavailable.txt")).contains("mtg_1");
            // The complete record is still there — only the readable copy is missing.
            assertThat(entries.get("meetings.json")).contains("Sprint planning");
        }
    }

    @Nested
    @DisplayName("twice in a row")
    class Reproducible {

        @Test
        @DisplayName("produces the same bytes, so a second download can be compared to the first")
        void isByteIdentical() {
            byte[] first = service.build(USER, "UTC").content();
            byte[] second = service.build(USER, "UTC").content();

            assertThat(second).isEqualTo(first);
        }
    }
}
