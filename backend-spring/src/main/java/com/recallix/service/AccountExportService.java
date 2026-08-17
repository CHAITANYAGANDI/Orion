package com.recallix.service;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.recallix.common.ApiException;
import com.recallix.domain.ExportFormat;
import com.recallix.entity.Meeting;
import com.recallix.entity.MeetingActionItem;
import com.recallix.entity.MeetingShare;
import com.recallix.entity.UserEntity;
import com.recallix.export.Downloads;
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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * The whole account, in a zip.
 *
 * <p>Section 21 made one meeting portable. This makes the archive portable,
 * which is a different promise and the one that matters when somebody is
 * deciding whether they are locked in — or whether it is safe to press the
 * button below it and close the account.
 *
 * <p><strong>Two copies of everything, on purpose.</strong> The JSON is the
 * complete record, field for field as stored, so nothing is lost and another
 * system could read it. The Markdown is the same meetings written the way a
 * person reads them, produced by the same renderer as the per-meeting export so
 * the two can never drift. An export that is only machine-readable is one nobody
 * opens; an export that is only human-readable is one nobody can migrate.
 *
 * <p><strong>What is not in here.</strong> The recordings. An account with fifty
 * hours of audio is gigabytes, and streaming that through a request thread to
 * bundle it is the denial-of-service tool {@link ExportService} already declined
 * to build for a single file. The README says so and points at the per-meeting
 * audio download, which hands the browser a signed URL and lets the object store
 * do the work it is for.
 */
@Service
public class AccountExportService {

    private static final Logger log = LoggerFactory.getLogger(AccountExportService.class);

    /**
     * Fixed timestamps on every entry.
     *
     * <p>Two exports of an unchanged account are then byte-identical, which is
     * the only way somebody can check that a second download really did contain
     * the same thing as the first — and the only way a test can assert on the
     * archive without asserting on the clock.
     */
    private static final long EPOCH = 0L;

    private final MeetingRepository meetings;
    private final MeetingSummaryRepository summaries;
    private final MeetingActionItemRepository actionItems;
    private final TranscriptSegmentRepository segments;
    private final TranscriptMomentRepository moments;
    private final MeetingInsightRepository insights;
    private final MeetingShareRepository shares;
    private final ProjectRepository projects;
    private final VocabularyTermRepository vocabulary;
    private final KnownSpeakerRepository speakers;
    private final UserRepository users;
    private final ExportService exports;
    private final ObjectMapper json;

    public AccountExportService(MeetingRepository meetings,
                                MeetingSummaryRepository summaries,
                                MeetingActionItemRepository actionItems,
                                TranscriptSegmentRepository segments,
                                TranscriptMomentRepository moments,
                                MeetingInsightRepository insights,
                                MeetingShareRepository shares,
                                ProjectRepository projects,
                                VocabularyTermRepository vocabulary,
                                KnownSpeakerRepository speakers,
                                UserRepository users,
                                ExportService exports) {
        this.meetings = meetings;
        this.summaries = summaries;
        this.actionItems = actionItems;
        this.segments = segments;
        this.moments = moments;
        this.insights = insights;
        this.shares = shares;
        this.projects = projects;
        this.vocabulary = vocabulary;
        this.speakers = speakers;
        this.users = users;
        this.exports = exports;
        // Its own mapper rather than the web one: this writes a file somebody
        // will open in a text editor, so it is indented, and it drops nulls so
        // that a meeting with no project does not carry twenty null fields
        // explaining what it does not have.
        this.json = new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
                .enable(SerializationFeature.INDENT_OUTPUT)
                .setSerializationInclusion(JsonInclude.Include.NON_NULL);
    }

    /**
     * Build the archive.
     *
     * <p>Assembled in memory rather than streamed. A workspace is one account
     * and the text of even a long archive is a few megabytes; streaming it would
     * mean writing the response after the transaction has closed, which is how
     * an export ends up half-written when a lazy read fails on the way out.
     */
    @Transactional(readOnly = true)
    public ExportFile build(String userId, String zone) {
        UserEntity user = users.findById(userId)
                .orElseThrow(() -> ApiException.unauthorized("Unknown user"));
        List<Meeting> owned = meetings.findByUserIdOrderByCreatedAtDesc(userId);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            write(zip, "README.txt", readme(user, owned).getBytes(StandardCharsets.UTF_8));
            write(zip, "account.json", toJson(account(user)));
            write(zip, "meetings.json", toJson(meetingRecords(owned)));
            write(zip, "action-items.csv", actionItemsCsv(userId).getBytes(StandardCharsets.UTF_8));

            for (Meeting meeting : owned) {
                try {
                    ExportFile notes = exports.render(
                            userId, meeting.getId(), ExportFormat.MARKDOWN, true, null, zone);
                    write(zip, "meetings/" + folder(meeting) + "/notes.md", notes.content());
                } catch (RuntimeException e) {
                    // One unreadable meeting must not cost somebody the other
                    // forty-nine. The JSON above already has it in full; this is
                    // the readable copy, and its absence is recorded in place.
                    log.warn("Export: could not render notes for {}: {}", meeting.getId(), e.toString());
                    write(zip, "meetings/" + folder(meeting) + "/notes-unavailable.txt",
                            ("These notes could not be rendered. The complete record of this "
                                    + "meeting is in meetings.json under id " + meeting.getId() + ".\n")
                                    .getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException("Could not build the export archive", e);
        }

        String filename = "recallix-export-" + LocalDate.now(ZoneOffset.UTC) + ".zip";
        return new ExportFile(filename, "application/zip", out.toByteArray());
    }

    /* ------------------------------- sections ------------------------------- */

    private Map<String, Object> account(UserEntity user) {
        Map<String, Object> account = new LinkedHashMap<>();
        account.put("id", user.getId());
        account.put("email", user.getEmail());
        account.put("displayName", user.getDisplayName());
        // Descriptive fields nothing else reads. They are in the export because
        // what somebody typed about themselves is data Recallix holds of theirs.
        account.put("department", user.getDepartment());
        account.put("jobRole", user.getJobRole());
        account.put("defaultLanguage", user.getDefaultLanguage());
        account.put("plan", user.getPlan());
        account.put("createdAt", user.getCreatedAt());
        account.put("preferences", Map.of(
                "autoEmailRecap", user.isAutoEmailRecap(),
                "recapEmail", user.effectiveRecapEmail() == null ? "" : user.effectiveRecapEmail(),
                "taskReminders", user.isTaskReminders(),
                "mutedNotifications", user.getMutedNotifications()));
        Map<String, Object> retention = new LinkedHashMap<>();
        retention.put("audioDays", user.getAudioRetentionDays());
        retention.put("meetingDays", user.getMeetingRetentionDays());
        account.put("retention", retention);
        account.put("projects", projects.findByUserIdOrderByFavoriteDescNameAsc(user.getId()));
        account.put("vocabulary", vocabulary.findByUserIdOrderByCategoryAscTermAsc(user.getId()));
        account.put("knownSpeakers", speakers.findByUserIdOrderByTimesUsedDescLastUsedAtDesc(user.getId()));
        account.put("shareLinks", shareRecords(user.getId()));
        return account;
    }

    /**
     * Share links without their passwords.
     *
     * <p>The one place in this archive where the stored row is not what gets
     * written out. A bcrypt hash of a share password is a credential: it is
     * worth nothing to the person downloading their own data and is worth
     * something to anybody who later finds the zip in a downloads folder.
     */
    private List<Map<String, Object>> shareRecords(String userId) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (MeetingShare share : shares.findByUserIdAndRevokedFalseOrderByCreatedAtDesc(userId)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", share.getId());
            row.put("meetingId", share.getMeetingId());
            row.put("label", share.getLabel());
            row.put("includeSummary", share.isIncludeSummary());
            row.put("includeActionItems", share.isIncludeActionItems());
            row.put("includeTranscript", share.isIncludeTranscript());
            row.put("includeAudio", share.isIncludeAudio());
            row.put("passwordProtected", share.isPasswordProtected());
            row.put("expiresAt", share.getExpiresAt());
            row.put("viewCount", share.getViewCount());
            row.put("lastViewedAt", share.getLastViewedAt());
            row.put("createdAt", share.getCreatedAt());
            rows.add(row);
        }
        return rows;
    }

    private List<Map<String, Object>> meetingRecords(List<Meeting> owned) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Meeting meeting : owned) {
            String id = meeting.getId();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("meeting", meeting);
            row.put("summary", summaries.findFirstByMeetingIdOrderByCreatedAtDesc(id).orElse(null));
            row.put("actionItems", actionItems.findByMeetingId(id));
            row.put("insights", insights.findByMeetingIdOrderByCreatedAt(id));
            row.put("marks", moments.findByMeetingIdOrderByStartSecondsAscCreatedAtAsc(id));
            row.put("segments", segments.findByMeetingIdOrderByStartTimeAsc(id));
            rows.add(row);
        }
        return rows;
    }

    /**
     * Every commitment in one flat file.
     *
     * <p>CSV because this is the one part of an archive people genuinely re-use:
     * action items go into whatever tracker they already have, and every tracker
     * on earth imports a spreadsheet.
     */
    private String actionItemsCsv(String userId) {
        Map<String, String> titles = new LinkedHashMap<>();
        meetings.findByUserIdOrderByCreatedAtDesc(userId)
                .forEach(m -> titles.put(m.getId(), m.getTitle()));

        StringBuilder csv = new StringBuilder("meeting,task,owner,due,priority,status\n");
        for (Map.Entry<String, String> entry : titles.entrySet()) {
            for (MeetingActionItem item : actionItems.findByMeetingId(entry.getKey())) {
                csv.append(cell(entry.getValue())).append(',')
                        .append(cell(item.getTitle())).append(',')
                        .append(cell(item.getOwnerName())).append(',')
                        .append(cell(item.getDueOn() == null ? "" : item.getDueOn().toString())).append(',')
                        .append(cell(item.getPriority())).append(',')
                        .append(cell(item.getStatus())).append('\n');
            }
        }
        return csv.toString();
    }

    private String readme(UserEntity user, List<Meeting> owned) {
        return """
                Your Recallix data
                ==================

                Exported %s for %s.
                %d meeting(s).

                WHAT IS IN HERE

                  account.json      Your profile, preferences, retention policy, projects,
                                    vocabulary, known speakers and live share links.
                  meetings.json     Every meeting in full: summary, action items, decisions,
                                    risks, highlights, notes and every transcript segment.
                                    This is the complete record — nothing is abbreviated.
                  action-items.csv  Every commitment, flat, ready for a spreadsheet or a
                                    tracker.
                  meetings/         The same meetings written to be read, one Markdown file
                                    each, identical to the per-meeting export.

                WHAT IS NOT

                  The recordings. An archive of any size is gigabytes of audio, and
                  bundling it here would mean pushing all of it through the API. Each
                  meeting page has a download for its own recording, which hands your
                  browser a signed link straight to storage instead.

                  Anything about anyone else. Recallix has one account per workspace, so
                  everything above is yours and only yours.

                A meeting whose transcript or recording you erased appears here without
                it. That is not a gap in the export — it is what erasure means.
                """.formatted(
                LocalDate.now(ZoneOffset.UTC),
                user.getEmail() == null || user.getEmail().isBlank() ? user.getId() : user.getEmail(),
                owned.size());
    }

    /* -------------------------------- plumbing ------------------------------ */

    private byte[] toJson(Object value) {
        try {
            return json.writeValueAsBytes(value);
        } catch (Exception e) {
            throw new IllegalStateException("Could not serialise the export", e);
        }
    }

    private static void write(ZipOutputStream zip, String path, byte[] content) throws IOException {
        ZipEntry entry = new ZipEntry(path);
        entry.setTime(EPOCH);
        zip.putNextEntry(entry);
        zip.write(content);
        zip.closeEntry();
    }

    /** A folder per meeting, named so the archive sorts the way the app lists it. */
    private static String folder(Meeting meeting) {
        return Downloads.slug(meeting.getTitle()) + "-" + meeting.getId();
    }

    /** Minimal RFC 4180: quote everything, double the quotes inside. */
    private static String cell(Object value) {
        String text = value == null ? "" : value.toString();
        return '"' + text.replace("\"", "\"\"") + '"';
    }
}
