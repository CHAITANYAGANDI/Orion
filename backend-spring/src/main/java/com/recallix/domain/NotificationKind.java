package com.recallix.domain;

import java.util.Arrays;
import java.util.Locale;
import java.util.Optional;

/**
 * The things Recallix will tell you about.
 *
 * <p>Each kind is an event that already happened somewhere in the system and
 * previously left no trace outside the log. The label is what the settings page
 * offers to switch off, so it is written from the reader's side — "when a
 * summary is ready", not {@code SUMMARY_READY}.
 *
 * <p><strong>On the three that a single-account product cannot have.</strong>
 * Recallix has one account per workspace: no teams, no members, no invitations.
 * So there is no "someone" to comment, to mention you, or to share a meeting
 * with you, and inventing one would mean notifying somebody about their own
 * actions — a product telling you what you just did. Two of the three have real
 * counterparts and are here under honest names: {@link #MENTIONED_IN_MEETING} is
 * a meeting that assigned work to you by name, which is what "mentioned you"
 * means when the mention comes from a transcript rather than a colleague, and
 * {@link #SHARE_VIEWED} is somebody outside opening a link you published, which
 * is the only genuinely other-party event the product has. The third — a comment
 * from another person — has no counterpart, because action item notes are a
 * private working log.
 *
 * <p>{@link #PROCESSING_FAILED} is not on anyone's wish list and is the one
 * people need most: an upload that quietly failed while the tab was closed is
 * the exact case this whole table exists for.
 */
public enum NotificationKind {

    /** A recording began — worth knowing on a second tab or another device. */
    RECORDING_STARTED("Recording started", "when a recording starts"),

    /** A meeting entered the pipeline: uploaded, imported or reprocessed. */
    PROCESSING_STARTED("Processing started", "when a meeting starts processing"),

    TRANSCRIPT_READY("Transcript ready", "when a transcript is ready"),

    SUMMARY_READY("Summary ready", "when the notes are written"),

    /** The pipeline gave up. Off by default is not an option worth offering. */
    PROCESSING_FAILED("Processing failed", "when a meeting fails to process"),

    RECAP_SENT("Recap sent", "when a recap email goes out"),

    ACTION_ITEM_DUE("Action items due", "when work is due today or soon"),

    ACTION_ITEM_OVERDUE("Action items overdue", "when work goes past its deadline"),

    /**
     * A meeting named you as the owner of something.
     *
     * <p>Requires a display name — without one, Recallix has no way to know
     * which "Priya" in a transcript is the person reading the screen.
     */
    MENTIONED_IN_MEETING("Mentioned in a meeting", "when a meeting assigns work to you by name"),

    /** A link you published was opened by somebody outside the workspace. */
    SHARE_VIEWED("Shared link opened", "when someone opens a link you shared");

    private final String label;
    private final String setting;

    NotificationKind(String label, String setting) {
        this.label = label;
        this.setting = setting;
    }

    public String label() {
        return label;
    }

    /** How the preference reads on the settings page: "Tell me …". */
    public String setting() {
        return setting;
    }

    /**
     * Whether this one can be switched off.
     *
     * <p>A failure is the one thing a notification list exists to carry. Muting
     * it turns silence into two indistinguishable states — nothing happened, and
     * something went wrong — which is the state this feature was built to end.
     */
    public boolean mutable() {
        return this != PROCESSING_FAILED;
    }

    public static Optional<NotificationKind> find(String raw) {
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        String value = raw.trim().toUpperCase(Locale.ROOT);
        return Arrays.stream(values()).filter(k -> k.name().equals(value)).findFirst();
    }
}
