-- Email as several decisions instead of one.
--
-- Until now a user had two email switches: `auto_email_recap` and
-- `task_reminders`. That was honest when those were the only two messages
-- Recallix sent, but it collapses two genuinely different questions into one.
-- Somebody who records four meetings a week and imports a sixty-file archive
-- wants the first four mailed and not the sixty, and today they can only have
-- both or neither.
--
-- Four columns, each one a message that actually gets sent:
--
--   emails_enabled     the master. Governs automatic mail only — a share you
--                      send by hand is a thing you just did, not a notification,
--                      and suppressing it would make the button lie.
--   recap_for_imports  the recap, for meetings that arrived as a file or a link
--                      rather than as a recording made here.
--   share_opened_email somebody outside opening a link you published. The only
--                      genuinely other-party event this product has, and until
--                      now it reached the bell and nowhere else.
--   digest_weekly      the deadline digest on Mondays instead of every morning.
--
-- `meetings.recorded` is what lets the recap split in two. It is asserted by
-- the browser recorder and by nothing else, the same shape as
-- `consent_confirmed` in V35: absent and false both mean "not recorded here",
-- which is the truthful state for a file that was captured somewhere Recallix
-- was not.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS emails_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS recap_for_imports BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS share_opened_email BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS digest_weekly BOOLEAN NOT NULL DEFAULT FALSE;

-- Splitting a switch must not quietly revoke what it used to cover. Anybody
-- with recaps on today is having imports mailed to them today, so the new
-- column starts where the old one already stands rather than at its default.
UPDATE users SET recap_for_imports = auto_email_recap;

-- Existing meetings become `recorded = FALSE`, and there is no way to recover
-- which of them were recorded here — the distinction was never stored. This
-- costs nothing: the flag is only ever read while a meeting is being processed,
-- and every row that exists now finished processing long ago.
ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS recorded BOOLEAN NOT NULL DEFAULT FALSE;

-- The share-open email needs its own dedupe, and cannot borrow the bell's.
-- A link posted to a mailing list is opened dozens of times in an afternoon,
-- and the notification is deduped per day already — but only when the bell
-- kind is unmuted, so a user who silenced the notification and wanted the
-- email would be mailed on every single open. One date per link, checked and
-- stamped where the mail is sent.
ALTER TABLE meeting_shares
    ADD COLUMN IF NOT EXISTS open_emailed_on DATE;

COMMENT ON COLUMN users.emails_enabled IS
    'Master switch over automatic email. User-initiated sends are unaffected.';
COMMENT ON COLUMN users.recap_for_imports IS
    'Recap email for meetings imported as a file or link; auto_email_recap covers recorded ones.';
COMMENT ON COLUMN users.share_opened_email IS
    'Email the owner when somebody opens a share link. Off by default; the bell already carries it.';
COMMENT ON COLUMN users.digest_weekly IS
    'Deadline digest on Mondays rather than daily. Ignored when task_reminders is off.';
COMMENT ON COLUMN meetings.recorded IS
    'Asserted by the browser recorder. False means the meeting arrived some other way.';
