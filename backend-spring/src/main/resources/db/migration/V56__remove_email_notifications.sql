-- Remove automatic email.
--
-- Recallix no longer sends mail of any kind. The settings tab that owned these
-- switches was deleted in the frontend when the settings page was cut to
-- General and Plans, which left the sending machinery running with no way for
-- anybody to reach it: every switch defaults to off, so nothing was going out,
-- and nobody could have turned one on if they wanted to.
--
-- Four messages went with it -- the meeting recap, the daily deadline reminder,
-- the Monday review, and the once-a-day notice about comments and highlights.
-- The bell is now the only channel, and it is the one that never needed an
-- address to work.
--
-- `users.email` is deliberately NOT dropped. It is the account address, it
-- identifies the person, and it is what an identity provider writes back on
-- every request. Only the mail preferences go.
--
-- The `*_emailed_on` and `task_reminder_sent_on` stamps existed to stop a
-- restart at the wrong minute sending the same digest twice. With nothing
-- sending, there is nothing to de-duplicate.

ALTER TABLE users
    DROP COLUMN IF EXISTS auto_email_recap,
    DROP COLUMN IF EXISTS recap_email,
    DROP COLUMN IF EXISTS recap_for_imports,
    DROP COLUMN IF EXISTS emails_enabled,
    DROP COLUMN IF EXISTS task_reminders,
    DROP COLUMN IF EXISTS weekly_digest,
    DROP COLUMN IF EXISTS task_reminder_sent_on,
    DROP COLUMN IF EXISTS comment_email,
    DROP COLUMN IF EXISTS comment_emailed_on,
    DROP COLUMN IF EXISTS highlight_email,
    DROP COLUMN IF EXISTS highlight_emailed_on;

-- Set when a recap was mailed, which is now never.
ALTER TABLE meetings
    DROP COLUMN IF EXISTS recap_sent_at;

-- Three notification kinds could only ever be raised by the jobs above:
-- RECAP_SENT reported a mail going out, and the two action-item kinds were
-- raised beside the morning digest. Rows are deleted rather than left to
-- render as an unknown kind in the bell.
DELETE FROM notifications
 WHERE kind IN ('RECAP_SENT', 'ACTION_ITEM_DUE', 'ACTION_ITEM_OVERDUE');

-- The same three, where somebody had muted them.
UPDATE users
   SET muted_notifications = COALESCE((
           SELECT jsonb_agg(k)
             FROM jsonb_array_elements(muted_notifications) AS k
            WHERE k #>> '{}' NOT IN ('RECAP_SENT', 'ACTION_ITEM_DUE', 'ACTION_ITEM_OVERDUE')
       ), '[]'::jsonb)
 WHERE muted_notifications @> '["RECAP_SENT"]'::jsonb
    OR muted_notifications @> '["ACTION_ITEM_DUE"]'::jsonb
    OR muted_notifications @> '["ACTION_ITEM_OVERDUE"]'::jsonb;
