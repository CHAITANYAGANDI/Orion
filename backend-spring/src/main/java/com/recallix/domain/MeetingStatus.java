package com.recallix.domain;

/** Meeting processing lifecycle — matches api-contracts §5. */
public enum MeetingStatus {
    CREATED,
    UPLOADED,
    QUEUED,
    TRANSCRIBING,
    SUMMARIZING,
    EXTRACTING,
    READY,
    FAILED
}
