-- One switch per message, and the cadence stops being a mode.
--
-- WHAT THE EMAIL PAGE USED TO BE
--   Four switches, one of which carried a dropdown: "Deadline digest" with a
--   cadence of "every morning" or "Mondays". That shape has a flaw the settings
--   page cannot show — the two cadences are not two settings of one message,
--   they are two different messages. "Three things are due today" is a prompt to
--   act this morning. "Here is your week" is a review. Somebody who wants both
--   could have neither, because the dropdown made them exclusive, and somebody
--   who wanted the Monday review had to describe it as a deadline reminder that
--   happens to be weekly.
--
--   So digest_weekly stops being a mode of task_reminders and the two become
--   independent switches: task_reminders is the daily deadline mail, and the new
--   weekly_digest is the Monday review. Both can be on, and Monday sends one
--   message rather than two — see TaskReminderService.
--
-- THE BACKFILL IS THE WHOLE POINT OF THIS MIGRATION
--   Every existing row has to land on the switch that means what its owner
--   chose, and there is exactly one reading of each combination:
--
--     task_reminders  digest_weekly   ->  task_reminders  weekly_digest
--     false           anything            false           false
--     true            false               true            false
--     true            true                false           true
--
--   The third line is the one that matters. Somebody on the weekly cadence asked
--   for a message on Mondays and nothing on Tuesdays; leaving task_reminders
--   true would start mailing them every morning, which is the failure mode a
--   preference migration exists to prevent. Turning off is recoverable by one
--   click; turning on unasked is what makes people filter the sender.
--
-- WHY digest_weekly IS DROPPED RATHER THAN LEFT
--   Nothing reads it after this and its data is fully carried by the two
--   booleans above. A column that still exists but no longer means what its name
--   says is worse than an absent one: the next person to read the schema would
--   reasonably wire something to it.
--
-- THE THREE NEW SWITCHES
--   live_meeting_email, comment_email and highlight_email each stand for an
--   event that already happens in Recallix and previously only reached the bell.
--   All three default to false, because an account that never asked for mail
--   must not start receiving it because a migration ran.
--
-- WHY THREE STAMPS, AND WHY ONE OF THEM IS NOT A DATE
--   comment_emailed_on and highlight_emailed_on hold the day their message last
--   went out, so a working afternoon of forty highlights is one mail rather than
--   forty. The same shape as meeting_shares.open_emailed_on and
--   users.task_reminder_sent_on.
--
--   live_meeting_emailed_at is an instant and its window is an hour, because the
--   thing it guards against is different in kind: starting, stopping and
--   restarting while hunting for a quiet room is three starts in five minutes,
--   and one a day would instead swallow the afternoon's genuinely separate
--   second meeting.
--
--   It is a column rather than a reuse of the RECORDING_STARTED notification's
--   own hourly dedupe key. Reading that key would tie the mail to the bell, and
--   muting the bell would then silently turn off an email somebody had switched
--   on — the two are separate channels and the settings page says so.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS weekly_digest           BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS live_meeting_email      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS comment_email           BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS highlight_email         BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS live_meeting_emailed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS comment_emailed_on      DATE,
    ADD COLUMN IF NOT EXISTS highlight_emailed_on    DATE;

-- Order matters: weekly_digest is derived from the pair, so it is written
-- before task_reminders is narrowed.
UPDATE users
   SET weekly_digest  = (task_reminders AND digest_weekly),
       task_reminders = (task_reminders AND NOT digest_weekly);

ALTER TABLE users
    DROP COLUMN IF EXISTS digest_weekly;

COMMENT ON COLUMN users.weekly_digest IS
    'Monday review of the week. Independent of task_reminders since V43; on Mondays with both on, only this one sends.';
COMMENT ON COLUMN users.task_reminders IS
    'Daily deadline mail. Meant every morning since V43 — the weekly cadence moved to weekly_digest.';
COMMENT ON COLUMN users.live_meeting_email IS
    'Mail when a recording starts. At most one an hour; see live_meeting_emailed_at.';
COMMENT ON COLUMN users.live_meeting_emailed_at IS
    'When the live-meeting mail last went out. An hour window rather than a day, so a restart is silent but a second meeting is not.';
COMMENT ON COLUMN users.comment_email IS
    'Mail when a comment lands on an action item. At most one a day; see comment_emailed_on.';
COMMENT ON COLUMN users.highlight_email IS
    'Mail when a highlight is added to a transcript. At most one a day; see highlight_emailed_on.';
COMMENT ON COLUMN users.comment_emailed_on IS
    'The day the comment mail last went out. Stamped only on a successful send, so an SMTP outage does not cost the day.';
COMMENT ON COLUMN users.highlight_emailed_on IS
    'The day the highlight mail last went out. Stamped only on a successful send.';
