package com.reverie.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "users")
public class UserEntity {

    @Id
    private String id;

    @Column(name = "clerk_user_id", nullable = false, unique = true)
    private String clerkUserId;

    private String email;

    @Column(nullable = false)
    private String plan = "FREE";

    /**
     * The name this user is called by in their own meetings.
     *
     * <p>The only way to answer "which of these tasks are mine". Nothing joins
     * an account to a transcript: the account has an email, the transcript has
     * "Priya", and there is no third fact relating them. Null means never told.
     */
    @Column(name = "display_name")
    private String displayName;

    /**
     * Descriptive profile fields, on the account page beside the name.
     *
     * <p>Nothing routes by either of them — Reverie has no teams, so there is
     * nothing a department could route to. They exist because somebody may want
     * to record them and because they go into the account export: what a user
     * typed about themselves is data Reverie holds of theirs. See V38.
     */
    @Column(name = "department")
    private String department;

    @Column(name = "job_role")
    private String jobRole;

    /**
     * How this person asks to be referred to: "she/her", "they/them".
     *
     * <p>Free text and not an enum, because every fixed list is wrong for
     * somebody and the whole point of the field is to stop the product
     * guessing. Shown beside the name; nothing infers it from anything.
     */
    @Column(name = "pronouns")
    private String pronouns;

    /**
     * The profile picture, as a data URL.
     *
     * <p>Inline rather than a key into object storage. It is rendered on every
     * page, so a presigned URL would either expire mid-session or need a public
     * bucket, and both are worse than a few tens of kilobytes on one row per
     * user. Downscaled in the browser before it is sent and capped on the way
     * in {—} see {@code PreferencesService}.
     */
    @Column(name = "avatar_url", columnDefinition = "text")
    private String avatarUrl;

    /**
     * The language meetings are held in, or null to auto-detect.
     *
     * <p>Unlike the two above, this one changes the transcript. Detection is
     * good and not perfect, and a wrong guess on a short or bilingual recording
     * comes back as words in the wrong language with nothing downstream able to
     * fix it. Resolved when a job is queued and sent with the event, the same as
     * the vocabulary — see {@code MeetingService.enqueueProcessing}.
     */
    @Column(name = "default_language")
    private String defaultLanguage;

    /**
     * How far back the workspace chat retrieves transcripts, or null for all.
     *
     * <p>A scope control, not a privacy boundary: nothing is hidden or deleted,
     * and the meeting's own page still answers about it. It does not bound the
     * commitment ledger — a task owed since March is still owed.
     */
    @Column(name = "chat_history_days")
    private Integer chatHistoryDays;

    /**
     * Email when somebody opens a link you published (V40).
     *
     * <p>Off by default, unlike the bell notification it accompanies. A link
     * sent to a mailing list can be opened fifty times in an afternoon, and the
     * bell absorbs that where an inbox does not.
     */

    /**
     * Notification kinds switched off.
     *
     * <p>A list of what is muted rather than of what is on, so everything is on
     * by default and a kind added later ships enabled rather than invisible.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "muted_notifications", columnDefinition = "jsonb")
    private List<String> mutedNotifications = new ArrayList<>();

    /**
     * Erase the recording this many days after a meeting is created.
     *
     * <p>Null keeps it, which is what every account did before this existed and
     * therefore the only default that cannot delete something nobody agreed to
     * lose. Everything drawn from the audio survives.
     */
    @Column(name = "audio_retention_days")
    private Integer audioRetentionDays;

    /** Erase the whole meeting this many days after it is created. Null keeps it. */
    @Column(name = "meeting_retention_days")
    private Integer meetingRetentionDays;

    /**
     * Opt-in to storing voice templates for the people this user names.
     *
     * <p>False for every existing account and every new one. While it is false
     * no speaker embedding is computed — not merely not stored — and
     * "Rematch speakers" has nothing to compare against. Setting it back to
     * false deletes every profile and voiceprint the account holds, because
     * withdrawing consent has to remove the data and not only its use.
     *
     * <p>The data behind this switch is biometric-adjacent: an ECAPA-TDNN
     * embedding is a stable identifier derived from a person's body, and is the
     * thing that makes one recording of them linkable to every other. See
     * {@code V53__speaker_profiles.sql}.
     */
    @Column(name = "speaker_learning_enabled", nullable = false)
    private boolean speakerLearningEnabled = false;

    /**
     * The five switchable messages Reverie sends by mail.
     *
     * <p>All false, for every existing account and every new one. Mail that
     * arrives because a migration ran is how a sender gets filtered, and a
     * filtered sender loses the one message that mattered along with the six
     * that did not. See {@code V64__account_email.sql}.
     *
     * <p>Two messages are deliberately absent from this list and cannot be
     * switched off: the allowance being fully spent, and the account being
     * closed. Both are terminal facts about the account rather than reports on
     * its contents, and the second has no switch left to read by the time it is
     * sent -- closing an account deletes this row.
     */
    @Column(name = "retention_warning_email", nullable = false)
    private boolean retentionWarningEmail = false;

    @Column(name = "retention_applied_email", nullable = false)
    private boolean retentionAppliedEmail = false;

    @Column(name = "task_reminder_email", nullable = false)
    private boolean taskReminderEmail = false;

    @Column(name = "notes_ready_email", nullable = false)
    private boolean notesReadyEmail = false;

    @Column(name = "allowance_email", nullable = false)
    private boolean allowanceEmail = false;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getClerkUserId() { return clerkUserId; }
    public void setClerkUserId(String clerkUserId) { this.clerkUserId = clerkUserId; }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getPlan() { return plan; }
    public void setPlan(String plan) { this.plan = plan; }



    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }

    public String getDepartment() { return department; }
    public void setDepartment(String department) { this.department = department; }

    public String getJobRole() { return jobRole; }
    public void setJobRole(String jobRole) { this.jobRole = jobRole; }

    public String getPronouns() { return pronouns; }
    public void setPronouns(String pronouns) { this.pronouns = pronouns; }

    public String getAvatarUrl() { return avatarUrl; }
    public void setAvatarUrl(String avatarUrl) { this.avatarUrl = avatarUrl; }

    public String getDefaultLanguage() { return defaultLanguage; }
    public void setDefaultLanguage(String defaultLanguage) { this.defaultLanguage = defaultLanguage; }

    public Integer getChatHistoryDays() { return chatHistoryDays; }
    public void setChatHistoryDays(Integer chatHistoryDays) { this.chatHistoryDays = chatHistoryDays; }










    public List<String> getMutedNotifications() {
        return mutedNotifications == null ? new ArrayList<>() : mutedNotifications;
    }

    public void setMutedNotifications(List<String> mutedNotifications) {
        this.mutedNotifications = mutedNotifications == null ? new ArrayList<>() : mutedNotifications;
    }

    public Integer getAudioRetentionDays() { return audioRetentionDays; }
    public void setAudioRetentionDays(Integer audioRetentionDays) { this.audioRetentionDays = audioRetentionDays; }

    public Integer getMeetingRetentionDays() { return meetingRetentionDays; }
    public void setMeetingRetentionDays(Integer meetingRetentionDays) { this.meetingRetentionDays = meetingRetentionDays; }

    public boolean isSpeakerLearningEnabled() { return speakerLearningEnabled; }
    public void setSpeakerLearningEnabled(boolean speakerLearningEnabled) { this.speakerLearningEnabled = speakerLearningEnabled; }

    /** Whether either dial is set — the one question the settings page asks. */
    public boolean hasRetentionPolicy() {
        return audioRetentionDays != null || meetingRetentionDays != null;
    }

    public boolean isRetentionWarningEmail() { return retentionWarningEmail; }
    public void setRetentionWarningEmail(boolean v) { this.retentionWarningEmail = v; }

    public boolean isRetentionAppliedEmail() { return retentionAppliedEmail; }
    public void setRetentionAppliedEmail(boolean v) { this.retentionAppliedEmail = v; }

    public boolean isTaskReminderEmail() { return taskReminderEmail; }
    public void setTaskReminderEmail(boolean v) { this.taskReminderEmail = v; }

    public boolean isNotesReadyEmail() { return notesReadyEmail; }
    public void setNotesReadyEmail(boolean v) { this.notesReadyEmail = v; }

    public boolean isAllowanceEmail() { return allowanceEmail; }
    public void setAllowanceEmail(boolean v) { this.allowanceEmail = v; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
