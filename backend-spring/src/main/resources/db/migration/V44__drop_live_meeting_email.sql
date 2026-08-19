-- The live-meeting email goes. Recallix cannot support it.
--
-- WHAT V43 BUILT AND WHY IT DOES NOT HOLD
--   V43 added a "Live meeting" switch and wired it to the one event that looked
--   like a counterpart: a recording starting. The row it was copied from means
--   something else entirely — a bot joins a calendar event and records it while
--   you are elsewhere, so the mail is the first you hear of it.
--
--   Recallix records from a browser tab that somebody opened on purpose. The
--   mail therefore arrives to report an action its reader had just taken, and
--   the "you might be on another machine" case it was justified by is thin
--   enough that it does not earn a switch, a column and an hourly dedupe.
--
--   The bell keeps RECORDING_STARTED. A row in a list somebody is already
--   looking at costs nothing; a message pushed to an inbox has to be worth
--   opening.
--
-- WHY THE COLUMNS GO RATHER THAN THE SWITCH BEING HIDDEN
--   A boolean nothing reads is a trap for whoever next wires something to it,
--   and the settings page is the only thing that ever wrote this one. Dropping
--   it costs the stored value, which is the correct loss: every account has it
--   false, because it was added off by default in V43 and V43 has not been in
--   front of anybody long enough to be turned on.
--
-- V43 IS NOT AMENDED IN PLACE
--   It has already run here. Rewriting an applied migration means a checksum
--   mismatch on the next boot and a hand-repair of flyway_schema_history, which
--   is a worse trade than an honest pair of migrations that say what happened.

ALTER TABLE users
    DROP COLUMN IF EXISTS live_meeting_email,
    DROP COLUMN IF EXISTS live_meeting_emailed_at;
