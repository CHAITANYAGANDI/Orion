-- --------------------------------------------------------------------------
-- V68 — remove cross-meeting voice identity, and erase the templates
-- --------------------------------------------------------------------------
--
-- Cross-meeting voice identity was removed from Reverie. These
-- biometric-adjacent templates are no longer used and are intentionally erased.
--
-- V53 built three things: a per-account table of named voices
-- (`speaker_profiles`), a per-meeting cache of one vector per canonical speaker
-- (`meeting_speaker_voiceprints`), and the consent column that gated both
-- (`users.speaker_learning_enabled`). They served one feature — "Rematch
-- speakers", plus the enrolment that a manual rename used to trigger — and that
-- feature is gone from the API, the services and the interface. Nothing reads
-- or writes any of this.
--
-- DROP rather than leave standing, and the reason is stronger here than for the
-- lists removed in V51. Every surviving row is an encrypted ECAPA-TDNN
-- embedding of a real person's voice. It was collected under an explicit opt-in
-- for a feature that no longer exists, there is no longer any screen that could
-- show somebody what is held about them, and no code path that could delete it
-- on request — the endpoints that did were removed with the feature. Retained,
-- invisible and unreachable is the worst of the three states it could be in.
--
-- Deliberately not archived, exported or copied anywhere first. There is no
-- version of "keep the voice templates just in case" that is better than
-- deleting them: the consent they were gathered under was for a capability the
-- product no longer offers.
--
-- This is not reversible. Restoring the tables would not restore the templates,
-- and should not — but it would restore the *shape* of a feature nobody can
-- reach, which is how dead schema outlives the code that explained it.
--
-- <h2>Order, and what goes automatically</h2>
--
-- `meeting_speaker_voiceprints` first. It has no foreign key to
-- `speaker_profiles` — both reference `users` and `meetings` directly — so
-- either order works, and the cache is dropped before the thing it fed anyway,
-- which is the order a reader expects.
--
-- Nothing anywhere references either table, so no `CASCADE` is needed and none
-- is used: a bare DROP that would fail on an unexpected dependent is better
-- than a CASCADE that would silently take it with them.
--
-- The indexes, unique constraints, check constraints, table and column
-- comments, and the V53 row-level-security policies are all dependents of the
-- tables and go with them. Naming them individually would only risk naming one
-- wrong.

DROP TABLE IF EXISTS meeting_speaker_voiceprints;
DROP TABLE IF EXISTS speaker_profiles;

-- The consent switch, which now gates nothing.
--
-- `users` itself is untouched: this removes one column from it and no rows. The
-- column was NOT NULL DEFAULT FALSE and was false for every account that never
-- opted in, so for almost everybody this drops a column that never changed from
-- its default. `UserEntity` stopped mapping it in stage 3A, so an application
-- running the previous release against this schema is unaffected either way.
ALTER TABLE users
    DROP COLUMN IF EXISTS speaker_learning_enabled;
