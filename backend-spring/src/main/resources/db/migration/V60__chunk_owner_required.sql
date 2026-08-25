-- Every transcript chunk has an owner.
--
-- WHY THIS MATTERS MORE THAN A TIDY SCHEMA
--
-- `transcript_chunks` is one of the few child tables that carries `user_id`
-- directly rather than reaching its owner through `meetings`, because retrieval
-- filters by owner across the whole workspace without joining. Its row-level
-- security policy is therefore the direct one:
--
--     USING (user_id = app_current_user())
--
-- A row with a NULL `user_id` satisfies that for nobody -- NULL = anything is
-- NULL, not true -- so such a row would be invisible to every tenant session.
-- Invisible is not harmless here. `ErasureService.eraseTranscript` runs on a
-- tenant connection and deletes chunks with
--
--     DELETE FROM transcript_chunks WHERE meeting_id = ?
--
-- which is filtered by the same policy. An unowned chunk would survive a
-- transcript erasure, unreachable and undeletable through the product, while
-- still holding an embedding of the words the account holder asked us to
-- destroy. "Deleted, except for the vectors nobody can see or remove" is the
-- one failure this table cannot be allowed to have.
--
-- WHY IT IS SAFE TO REQUIRE IT
--
-- Only one writer exists: the ai-service indexer. It returns early when the
-- owner is unknown rather than writing an unowned row, and the RLS WITH CHECK
-- on the same policy would refuse the insert regardless -- the connection has
-- `app.user_id` set and NULL would not match it. So the column is already
-- non-null by construction in two independent ways; this migration writes the
-- invariant down where the database can enforce it, instead of relying on both
-- of them staying true.
--
-- There are no system-owned chunks. Every chunk is derived from one account's
-- meeting, and the ai-service holds no privilege to write outside a tenant.

-- Defensive, though it should find nothing: any chunk predating the invariant
-- takes the owner of the meeting it belongs to. Verified empty on the live
-- database before this was written (0 chunks, 0 with a NULL owner).
UPDATE transcript_chunks c
   SET user_id = m.user_id
  FROM meetings m
 WHERE m.id = c.meeting_id
   AND c.user_id IS NULL;

-- If anything is still unowned it belongs to no meeting either, which the
-- foreign key already forbids. Failing loudly here is correct: silently
-- deleting rows in a migration is how transcripts disappear.
ALTER TABLE transcript_chunks
    ALTER COLUMN user_id SET NOT NULL;

COMMENT ON COLUMN transcript_chunks.user_id IS
    'Owner, denormalised for workspace-wide retrieval and checked by RLS. Never null: an unowned chunk would be invisible to its owner and survive transcript erasure.';
