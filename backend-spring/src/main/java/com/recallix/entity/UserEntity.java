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

    /** Mail a daily digest of what is overdue or due soon. */
    @Column(name = "task_reminders", nullable = false)
    private boolean taskReminders = false;

    /** The last day a digest went out — the guard against sending two. */
    @Column(name = "task_reminder_sent_on")
    private LocalDate taskReminderSentOn;

    /**
     * Notification kinds switched off.
     *
     * <p>A list of what is muted rather than of what is on, so everything is on
     * by default and a kind added later ships enabled rather than invisible.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "muted_notifications", columnDefinition = "jsonb")
    private List<String> mutedNotifications = new ArrayList<>();

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

    public boolean isTaskReminders() { return taskReminders; }
    public void setTaskReminders(boolean taskReminders) { this.taskReminders = taskReminders; }

    public LocalDate getTaskReminderSentOn() { return taskReminderSentOn; }
    public void setTaskReminderSentOn(LocalDate taskReminderSentOn) { this.taskReminderSentOn = taskReminderSentOn; }

    public List<String> getMutedNotifications() {
        return mutedNotifications == null ? new ArrayList<>() : mutedNotifications;
    }

    public void setMutedNotifications(List<String> mutedNotifications) {
        this.mutedNotifications = mutedNotifications == null ? new ArrayList<>() : mutedNotifications;
    }

    /** Where recaps go: the override when set, otherwise the account address. */
    public String effectiveRecapEmail() {
        return recapEmail != null && !recapEmail.isBlank() ? recapEmail.trim() : email;
    }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
