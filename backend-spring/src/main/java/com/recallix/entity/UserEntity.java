package com.recallix.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.time.LocalDate;
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

    /** Mail the recap automatically when a meeting finishes processing. */
    @Column(name = "auto_email_recap", nullable = false)
    private boolean autoEmailRecap = false;

    /** Overrides {@link #email} as the recap destination when set. */
    @Column(name = "recap_email")
    private String recapEmail;

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
     * <p>Nothing routes by either of them — Recallix has no teams, so there is
     * nothing a department could route to. They exist because somebody may want
     * to record them and because they go into the account export: what a user
     * typed about themselves is data Recallix holds of theirs. See V38.
     */
    @Column(name = "department")
    private String department;

    @Column(name = "job_role")
    private String jobRole;

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
     * What a new share link reveals before anybody touches it, and when it
     * expires.
     *
     * <p>These were constants in {@code ShareService}: good defaults, and
     * somebody else's opinion. Every link still carries its own four flags and
     * its own expiry — this is only what the boxes are set to. Changing them
     * never rewrites a link already sent, because that would revoke access
     * nobody asked to revoke. See V39.
     */
    @Column(name = "share_include_summary", nullable = false)
    private boolean shareIncludeSummary = true;

    @Column(name = "share_include_action_items", nullable = false)
    private boolean shareIncludeActionItems = true;

    @Column(name = "share_include_transcript", nullable = false)
    private boolean shareIncludeTranscript = false;

    @Column(name = "share_include_audio", nullable = false)
    private boolean shareIncludeAudio = false;

    /** Days until a new link expires, or null for never. */
    @Column(name = "share_expiry_days")
    private Integer shareExpiryDays;

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
     * Mail every morning about what is overdue or due soon ("Event reminder").
     *
     * <p>Every morning, full stop, since V43. It used to carry a cadence — see
     * {@link #weeklyDigest} for why that stopped being a mode of this switch and
     * became a switch of its own.
     */
    @Column(name = "task_reminders", nullable = false)
    private boolean taskReminders = false;

    /**
     * The Monday review of the week (V43).
     *
     * <p>Independent of {@link #taskReminders} rather than a cadence for it. The
     * two are different messages, not two settings of one: a daily reminder is a
     * prompt to act this morning, a Monday review is a look back. As a mode they
     * were mutually exclusive, so somebody who wanted both could have neither.
     *
     * <p>When both are on and it is a Monday, one message goes out — this one.
     * See {@code TaskReminderService}.
     */
    @Column(name = "weekly_digest", nullable = false)
    private boolean weeklyDigest = false;

    /** The last day a digest went out — the guard against sending two. */
    @Column(name = "task_reminder_sent_on")
    private LocalDate taskReminderSentOn;

    /**
     * Mail when a comment lands on an action item ("Comments", V43).
     *
     * <p>At most one a day — see {@link #commentEmailedOn}. Working through a
     * meeting's tasks produces a burst of notes in one sitting, and a message
     * per note is how somebody builds a filter rule and stops reading the
     * sender entirely.
     */
    @Column(name = "comment_email", nullable = false)
    private boolean commentEmail = false;

    /** The day the comment mail last went out; null if never. */
    @Column(name = "comment_emailed_on")
    private LocalDate commentEmailedOn;

    /**
     * Mail when a highlight is added to a transcript ("Highlights", V43).
     *
     * <p>At most one a day, for the same reason as {@link #commentEmail}:
     * reading a transcript through and marking it up is one activity, not
     * fifteen events.
     */
    @Column(name = "highlight_email", nullable = false)
    private boolean highlightEmail = false;

    /** The day the highlight mail last went out; null if never. */
    @Column(name = "highlight_emailed_on")
    private LocalDate highlightEmailedOn;

    /**
     * The master switch over automatic email (V40).
     *
     * <p>On by default, because it governs messages that are each already
     * opt-in — arriving with everything pre-suppressed would mean a switch
     * somebody turned on doing nothing, which is worse than either state.
     *
     * <p>Automatic only. Sharing a meeting by email is something the account
     * holder just did on purpose, and refusing to send it because of a
     * preference about notifications would make the button a liar.
     */
    @Column(name = "emails_enabled", nullable = false)
    private boolean emailsEnabled = true;

    /**
     * Recap email for meetings that arrived as a file or a link (V40).
     *
     * <p>The counterpart of {@link #autoEmailRecap}, which now covers only
     * meetings recorded here. Split because importing an archive and recording
     * a call are different acts at wildly different volumes, and one switch
     * over both meant anybody doing the first had to give up the second.
     */
    @Column(name = "recap_for_imports", nullable = false)
    private boolean recapForImports = false;

    /**
     * Email when somebody opens a link you published (V40).
     *
     * <p>Off by default, unlike the bell notification it accompanies. A link
     * sent to a mailing list can be opened fifty times in an afternoon, and the
     * bell absorbs that where an inbox does not.
     */
    @Column(name = "share_opened_email", nullable = false)
    private boolean shareOpenedEmail = false;

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

    public boolean isAutoEmailRecap() { return autoEmailRecap; }
    public void setAutoEmailRecap(boolean autoEmailRecap) { this.autoEmailRecap = autoEmailRecap; }

    public String getRecapEmail() { return recapEmail; }
    public void setRecapEmail(String recapEmail) { this.recapEmail = recapEmail; }

    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }

    public String getDepartment() { return department; }
    public void setDepartment(String department) { this.department = department; }

    public String getJobRole() { return jobRole; }
    public void setJobRole(String jobRole) { this.jobRole = jobRole; }

    public String getDefaultLanguage() { return defaultLanguage; }
    public void setDefaultLanguage(String defaultLanguage) { this.defaultLanguage = defaultLanguage; }

    public boolean isShareIncludeSummary() { return shareIncludeSummary; }
    public void setShareIncludeSummary(boolean v) { this.shareIncludeSummary = v; }

    public boolean isShareIncludeActionItems() { return shareIncludeActionItems; }
    public void setShareIncludeActionItems(boolean v) { this.shareIncludeActionItems = v; }

    public boolean isShareIncludeTranscript() { return shareIncludeTranscript; }
    public void setShareIncludeTranscript(boolean v) { this.shareIncludeTranscript = v; }

    public boolean isShareIncludeAudio() { return shareIncludeAudio; }
    public void setShareIncludeAudio(boolean v) { this.shareIncludeAudio = v; }

    public Integer getShareExpiryDays() { return shareExpiryDays; }
    public void setShareExpiryDays(Integer shareExpiryDays) { this.shareExpiryDays = shareExpiryDays; }

    public Integer getChatHistoryDays() { return chatHistoryDays; }
    public void setChatHistoryDays(Integer chatHistoryDays) { this.chatHistoryDays = chatHistoryDays; }

    public boolean isTaskReminders() { return taskReminders; }
    public void setTaskReminders(boolean taskReminders) { this.taskReminders = taskReminders; }

    public boolean isWeeklyDigest() { return weeklyDigest; }
    public void setWeeklyDigest(boolean weeklyDigest) { this.weeklyDigest = weeklyDigest; }

    public boolean isCommentEmail() { return commentEmail; }
    public void setCommentEmail(boolean commentEmail) { this.commentEmail = commentEmail; }

    public LocalDate getCommentEmailedOn() { return commentEmailedOn; }
    public void setCommentEmailedOn(LocalDate commentEmailedOn) { this.commentEmailedOn = commentEmailedOn; }

    public boolean isHighlightEmail() { return highlightEmail; }
    public void setHighlightEmail(boolean highlightEmail) { this.highlightEmail = highlightEmail; }

    public LocalDate getHighlightEmailedOn() { return highlightEmailedOn; }
    public void setHighlightEmailedOn(LocalDate highlightEmailedOn) { this.highlightEmailedOn = highlightEmailedOn; }

    public boolean isEmailsEnabled() { return emailsEnabled; }
    public void setEmailsEnabled(boolean emailsEnabled) { this.emailsEnabled = emailsEnabled; }

    public boolean isRecapForImports() { return recapForImports; }
    public void setRecapForImports(boolean recapForImports) { this.recapForImports = recapForImports; }

    public boolean isShareOpenedEmail() { return shareOpenedEmail; }
    public void setShareOpenedEmail(boolean shareOpenedEmail) { this.shareOpenedEmail = shareOpenedEmail; }

    public LocalDate getTaskReminderSentOn() { return taskReminderSentOn; }
    public void setTaskReminderSentOn(LocalDate taskReminderSentOn) { this.taskReminderSentOn = taskReminderSentOn; }

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

    /** Whether either dial is set — the one question the settings page asks. */
    public boolean hasRetentionPolicy() {
        return audioRetentionDays != null || meetingRetentionDays != null;
    }

    /** Where recaps go: the override when set, otherwise the account address. */
    public String effectiveRecapEmail() {
        return recapEmail != null && !recapEmail.isBlank() ? recapEmail.trim() : email;
    }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
