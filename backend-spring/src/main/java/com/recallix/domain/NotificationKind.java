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
 * is the only genuinely other-party event the product has. The third — a comment
 * from another person — has no counterpart, because action item notes are a
 * private working log.
 *
 * <p>{@link #PROCESSING_FAILED} is not on anyone's wish list and is the one
 * people need most: an upload that quietly failed while the tab was closed is
 * the exact case this whole table exists for.
 *
 * <p><strong>Two of these have no switch</strong>, and they are the two whose
 * silence is indistinguishable from nothing having happened: a failure, and an
 * erasure. {@link #RETENTION_APPLIED} is the more dangerous of the pair, because
 * the rule behind it was set once and then fires unattended for years.
 */
public enum NotificationKind {

    /**
     * A recording began. <strong>Retired — nothing emits this any more.</strong>
     */
    RECORDING_STARTED("Recording started", "when a recording starts", true),

    /**
     * A meeting entered the pipeline. <strong>Retired — nothing emits this any
     * more.</strong>
     */
    PROCESSING_STARTED("Processing started", "when a meeting starts processing", true),

    TRANSCRIPT_READY("Transcript ready", "when a transcript is ready"),

    SUMMARY_READY("Summary ready", "when the notes are written"),

    /** The pipeline gave up. Off by default is not an option worth offering. */
    PROCESSING_FAILED("Processing failed", "when a meeting fails to process"),

    /**
     * A meeting named you as the owner of something.
     *
     * <p>Requires a display name — without one, Recallix has no way to know
     * which "Priya" in a transcript is the person reading the screen.
     */
    MENTIONED_IN_MEETING("Mentioned in a meeting", "when a meeting assigns work to you by name"),

    /** A link you published was opened by somebody outside the workspace. */

    /**
     * Your retention policy erased something. Cannot be switched off.
     *
     * <p>The rule was set deliberately and runs unattended months later, which
     * is exactly when its owner has stopped thinking about it. Deleting somebody
     * else's data silently is the behaviour a privacy control exists to prevent,
     * even when the somebody else asked for it.
     */
    RETENTION_APPLIED("Retention applied", "when your retention policy deletes something");

    private final String label;
    private final String setting;
    private final boolean retired;

    NotificationKind(String label, String setting) {
        this(label, setting, false);
    }

    NotificationKind(String label, String setting, boolean retired) {
        this.label = label;
        this.setting = setting;
        this.retired = retired;
    }

    /**
     * Kept so old rows still map, but never emitted and never offered.
     *
     * <p>Two of these announced things the reader had just done on the device
     * they were doing them on: pressing Record, and pressing Save. Each one
     * cost a row in the bell, and "Processing started — we'll tell you when the
     * notes are ready" cost one <em>per meeting</em> to promise the
     * notification that follows it. Between them they were most of what a
     * normal afternoon put in the list, and none of it was news.
     *
     * <p>Deleting the constants was the obvious move and is the wrong one: the
     * kind is stored as its name, so every notification already written with
     * one of these would stop mapping and take the whole list down with it. The
     * value stays and the emission goes.
     *
     * <p>The settings switch goes too. A switch for something that can never
     * happen is worse than no switch — it implies the opposite state is
     * reachable.
     */
    public boolean retired() {
        return retired;
    }

    /** Every kind still worth offering on the settings page. */
    public static java.util.List<NotificationKind> active() {
        return Arrays.stream(values()).filter(k -> !k.retired()).toList();
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
     * <p>Two are not. A failure is the one thing a notification list exists to
     * carry: muting it turns silence into two indistinguishable states — nothing
     * happened, and something went wrong — which is the state this feature was
     * built to end. An erasure is the same shape with the stakes reversed:
     * nothing happened, and something is gone for good.
     */
    public boolean mutable() {
        return this != PROCESSING_FAILED && this != RETENTION_APPLIED;
    }

    public static Optional<NotificationKind> find(String raw) {
        if (raw == null || raw.isBlank()) {
            return Optional.empty();
        }
        String value = raw.trim().toUpperCase(Locale.ROOT);
        return Arrays.stream(values()).filter(k -> k.name().equals(value)).findFirst();
    }
}
