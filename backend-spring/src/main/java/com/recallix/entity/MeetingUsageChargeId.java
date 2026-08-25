package com.recallix.entity;

import java.io.Serializable;
import java.util.Objects;

/** Composite key of {@link MeetingUsageCharge}: one processing attempt of one meeting. */
public class MeetingUsageChargeId implements Serializable {

    private String meetingId;
    private int attempt;

    public MeetingUsageChargeId() {
    }

    public MeetingUsageChargeId(String meetingId, int attempt) {
        this.meetingId = meetingId;
        this.attempt = attempt;
    }

    public String getMeetingId() { return meetingId; }
    public void setMeetingId(String meetingId) { this.meetingId = meetingId; }

    public int getAttempt() { return attempt; }
    public void setAttempt(int attempt) { this.attempt = attempt; }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof MeetingUsageChargeId other)) {
            return false;
        }
        return attempt == other.attempt && Objects.equals(meetingId, other.meetingId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(meetingId, attempt);
    }
}
