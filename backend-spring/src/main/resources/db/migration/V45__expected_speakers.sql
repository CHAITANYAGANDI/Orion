-- How many voices to tell the transcriber to expect, per meeting.
--
-- Null on both is automatic, which is what every meeting recorded before this
-- migration is and what every meeting stays unless a human says otherwise.
-- These reach AssemblyAI as hard constraints: an exact count forces diarization
-- to find that many speakers whether or not that many spoke, so nothing infers
-- them from a calendar or an attendee list.
--
-- Bounded in the database as well as in the DTO. The provider accepts 1..10,
-- and a constraint that only exists in application code is one an import script
-- can walk straight past.
ALTER TABLE meetings
    ADD COLUMN expected_speakers_min INT,
    ADD COLUMN expected_speakers_max INT;

ALTER TABLE meetings
    ADD CONSTRAINT meetings_expected_speakers_min_range
        CHECK (expected_speakers_min IS NULL OR expected_speakers_min BETWEEN 1 AND 10),
    ADD CONSTRAINT meetings_expected_speakers_max_range
        CHECK (expected_speakers_max IS NULL OR expected_speakers_max BETWEEN 1 AND 10),
    ADD CONSTRAINT meetings_expected_speakers_ordered
        CHECK (
            expected_speakers_min IS NULL
            OR expected_speakers_max IS NULL
            OR expected_speakers_min <= expected_speakers_max
        );
