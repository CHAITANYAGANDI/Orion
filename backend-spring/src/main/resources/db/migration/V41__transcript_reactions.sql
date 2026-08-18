-- A fourth kind of mark: a reaction.
--
-- WHY THIS REOPENS A DECISION V27 CLOSED
--   V27 says, in as many words, "no reactions", and the reason it gave was
--   right: a reaction in Slack or in a shared Otter workspace is one person
--   addressing another, and Recallix has one user per workspace, so there is
--   nobody on the other end of a thumbs-up. That argument rules out *social*
--   reactions and it still does. Nothing here notifies anyone, nothing here
--   aggregates a count across accounts, and a reaction is never shown to the
--   holder of a share link.
--
--   What it does not rule out is the gesture underneath, which is the reason
--   people reach for reactions on their own documents: tagging a passage with
--   a feeling, in one click, without stopping to write a sentence about it.
--   That is a highlight with a word attached — "I agree with this", "this is
--   the bit that matters", "I did not follow this" — and it is worth having
--   precisely because writing a note is enough friction that people listening
--   to a recording do not do it.
--
-- WHY IT IS A MOMENT AND NOT ITS OWN TABLE
--   Same argument V27 made for the other three. A reaction is "this part of
--   this meeting matters", anchored to a moment, owned by one user, created
--   and deleted the same way. It differs from a bookmark by one field: the
--   body holds an emoji instead of a label. A separate table would be a second
--   CRUD path, a second RLS policy and a second erasure hook to express that.
--
-- WHY THE BODY IS THE EMOJI AND NOT A CODE
--   Storing ':thumbsup:' would mean owning a name-to-glyph table, and picking
--   which vendor's names to follow. The character is the datum; every layer
--   above this one already carries UTF-8, and rendering it is the font's job.
--
-- WHAT A REACTION ANCHORS TO
--   A turn, by its start time, exactly like a bookmark: `ranges` is empty and
--   `quote` holds the opening words for the list to show. Anchoring to a
--   character span would make the same click mean something different
--   depending on where in the paragraph the pointer happened to be, and would
--   break on the next transcript edit for no gain.

ALTER TABLE transcript_moments
    DROP CONSTRAINT IF EXISTS ck_transcript_moments_kind;

ALTER TABLE transcript_moments
    ADD CONSTRAINT ck_transcript_moments_kind
    CHECK (kind IN ('HIGHLIGHT', 'BOOKMARK', 'NOTE', 'REACTION'));

-- A reaction with no body is a mark with nothing on it: indistinguishable from
-- a bookmark in the list, and nothing to draw on the turn.
ALTER TABLE transcript_moments
    DROP CONSTRAINT IF EXISTS ck_transcript_moments_reaction_body;

ALTER TABLE transcript_moments
    ADD CONSTRAINT ck_transcript_moments_reaction_body
    CHECK (kind <> 'REACTION' OR length(btrim(body)) > 0);

-- One of each emoji per turn.
--
-- The toggle is client-side — tapping a reaction that is already there deletes
-- it — so a duplicate only arrives from a double-click that raced itself, or
-- from two tabs open on the same meeting. Either way the second row would be
-- invisible: it renders exactly on top of the first, and the count beside it
-- would say 2 where one person clicked once. The service checks for the
-- existing row and returns it, so this index is the backstop rather than the
-- mechanism; it is here because the check and the insert are two statements.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transcript_moments_reaction
    ON transcript_moments (meeting_id, user_id, start_seconds, body)
    WHERE kind = 'REACTION';

COMMENT ON COLUMN transcript_moments.body IS
    'A note''s text, a bookmark''s label, or a reaction''s emoji. Empty for a highlight.';
