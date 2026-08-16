-- Reading a whole meeting in another language.
--
-- Translation already existed and was a demo of itself: it took the summary's
-- three flat fields, held the result in the browser's memory, and threw it away
-- on navigation. The structured sections — which is where a modern brief keeps
-- almost all of its content — were dropped on the floor, so switching language
-- silently showed you less of the meeting than staying in English did. The
-- transcript and the action items could not be translated at all.
--
-- WHY THIS IS A TABLE AND NOT A REQUEST
--   A summary is a few hundred words and re-translating it per page view is
--   merely wasteful. A transcript is not: an hour of speech is several thousand
--   words across hundreds of utterances, and it costs real money and tens of
--   seconds every single time. A reader who switches to Spanish, opens the
--   transcript, goes to the action items and comes back would pay for that
--   twice. So a translation is a thing that exists, keyed by the meeting and the
--   language, and is produced once.
--
-- WHY THE TWO HALVES ARE SEPARATE
--   `brief_translated_at` and `transcript_translated_at` are what make the
--   expensive half optional. Choosing a language translates the brief, which is
--   fast; the transcript is translated only when somebody actually opens it and
--   asks. Nulls here mean "not translated yet" rather than "empty", which is why
--   they are timestamps and not booleans — the answer to "how old is this" is
--   worth having when the source has moved on.
--
-- STALENESS
--   Same problem the summary had in V25, one layer further out. Editing a
--   transcript or rewriting a summary leaves every translation of it describing
--   text that no longer exists, and nothing on screen would say so. `stale` is
--   set by the same places that set `meeting_summaries.stale`, and the UI offers
--   a retranslate rather than spending a model call on every typo fix.
--
-- WHAT IS NOT TRANSLATED
--   Quotations. A quote is a claim about the exact words somebody said, and a
--   translated quote is not a quote — it is a paraphrase wearing quotation
--   marks. They stay in the original and the UI keeps them labelled as such.

CREATE TABLE IF NOT EXISTS meeting_translations (
    id           TEXT PRIMARY KEY,
    meeting_id   TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    -- ISO-639-1, always the bare two-letter code. See domain/Language: input is
    -- forgiving about "en_us" and "Spanish", storage is not.
    language     TEXT NOT NULL,

    -- The brief. Mirrors meeting_summaries so the translated view can be served
    -- through the same response shape the untranslated one uses.
    short_summary    TEXT NOT NULL DEFAULT '',
    detailed_summary TEXT NOT NULL DEFAULT '',
    key_points       JSONB NOT NULL DEFAULT '[]'::jsonb,
    sections         JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- [{id, sourceTitle, title, ownerName, dueDate}]. `sourceTitle` is the
    -- English the translation was made from: when somebody later corrects a
    -- task's wording, the row no longer matches and the reader is shown the
    -- original rather than a translation of a sentence that has been replaced.
    action_items JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- [{id, text}], keyed by transcript_segments.id. Only the words are stored —
    -- speaker, timings and word-level timings all come from the live segment, so
    -- a translated transcript cannot disagree with the player about who spoke
    -- when.
    segments JSONB NOT NULL DEFAULT '[]'::jsonb,

    brief_translated_at      TIMESTAMPTZ,
    transcript_translated_at TIMESTAMPTZ,

    stale      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_meeting_translations_language
        CHECK (language ~ '^[a-z]{2}$')
);

-- One translation per language per meeting. Asking for Spanish twice must
-- update the Spanish translation, not create a second one that the next read
-- picks between arbitrarily.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_translations_meeting_language
    ON meeting_translations (meeting_id, language);

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
-- Owned through the meeting, like every other meeting_* table.
ALTER TABLE meeting_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_translations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON meeting_translations;
CREATE POLICY tenant_isolation ON meeting_translations
    FOR ALL
    USING (EXISTS (
        SELECT 1 FROM meetings m
        WHERE m.id = meeting_translations.meeting_id AND m.user_id = app_current_user()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM meetings m
        WHERE m.id = meeting_translations.meeting_id AND m.user_id = app_current_user()
    ));

COMMENT ON TABLE meeting_translations IS
    'One meeting rendered in one language. Brief and transcript are translated separately; quotations never are.';
COMMENT ON COLUMN meeting_translations.stale IS
    'True when the transcript or summary changed after this translation was made.';
