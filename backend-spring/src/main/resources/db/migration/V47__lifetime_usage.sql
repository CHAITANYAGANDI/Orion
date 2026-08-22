-- The allowance stops being monthly.
--
-- It was five meetings per calendar month, with a row in this table per user
-- per month and a rollover that handed everybody a fresh five on the 1st. It is
-- now one allowance per account for the life of that account: 100 transcribed
-- minutes and 3 imported files, enforced in UsageLimitService. Recording in the
-- browser is not capped by count any more -- the minutes are the ceiling, and
-- they are the thing that actually costs something to serve.
--
-- Two consequences are deliberate and worth stating here rather than in a
-- commit message:
--
--   * There is no period left, so period_start and period_end go. A lifetime
--     allowance has no reset date, and a column holding one would be read as a
--     promise that it does.
--
--   * The count starts from today rather than from the day each account was
--     made. Every counter is cleared. The rows being deleted recorded a monthly
--     allowance that no longer exists, and carrying their numbers over would
--     charge people for minutes they spent under a different set of rules --
--     including one account at 705 minutes, which would open this release
--     already locked out.

DELETE FROM usage_limits;

ALTER TABLE usage_limits
    DROP COLUMN period_start,
    DROP COLUMN period_end,
    ADD COLUMN imports_used INTEGER NOT NULL DEFAULT 0;

-- One row per account, now that there is no period to have two of. The service
-- reads by user_id and creates the row on first use; without this, a race
-- between two first requests would leave an account with two counters and twice
-- the allowance.
ALTER TABLE usage_limits
    ADD CONSTRAINT usage_limits_user_unique UNIQUE (user_id);
