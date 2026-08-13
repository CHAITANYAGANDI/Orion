-- Custom vocabulary and remembered speakers.
--
-- VOCABULARY
--   Transcription is accurate on ordinary speech and wrong on exactly the words
--   that carry the meaning: product names, people's names, jargon and acronyms.
--   Those errors are load-bearing, because the summary, the action items and
--   RAG chat are all written from this text.
--
--   One table rather than four. "Keyword", "custom name", "technical jargon"
--   and "acronym" differ in what the user is telling us, not in what we do with
--   it — every one of them ends up in the same boosting list on the
--   transcription request. Splitting them into separate tables would give four
--   identical schemas and four identical CRUD paths; splitting them by a
--   `category` column keeps the UI able to present them separately (and lets us
--   treat them differently later) at no structural cost.
--
--   `expansion` exists for acronyms only: "SRE" -> "site reliability
--   engineering" is a fact about the term that a summary can use, and is not
--   expressible as another term.
--
-- KNOWN SPEAKERS
--   Diarization labels voices "Speaker 1", "Speaker 2". Renaming them is
--   already possible, but the names were thrown away the moment the transcript
--   was left — so the same weekly standup was renamed by hand every week.
--   Remembering them per user turns the rename box into a pick-list.
--
--   Deliberately NOT voiceprints. Storing biometric voice embeddings to
--   auto-identify people carries consent and data-protection weight that a
--   name list does not, and the name list removes most of the tedium. The
--   `times_used` / `last_used_at` counters are what make the suggestions
--   ordered usefully rather than alphabetically.

CREATE TABLE IF NOT EXISTS vocabulary_terms (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    term        TEXT NOT NULL,
    category    TEXT NOT NULL,
    -- Acronyms only: what the letters stand for. Empty for every other kind.
    expansion   TEXT NOT NULL DEFAULT '',
    -- Turned off rather than deleted, so a term that caused a bad boost can be
    -- disabled without losing it and without renumbering anything.
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_vocabulary_terms_category
        CHECK (category IN ('KEYWORD', 'NAME', 'JARGON', 'ACRONYM')),
    CONSTRAINT ck_vocabulary_terms_term CHECK (length(btrim(term)) BETWEEN 1 AND 120)
);

-- Case-insensitive: a user who already added "Kubernetes" should be told they
-- have it, not given a second row for "kubernetes" that doubles its weight in
-- the boosting list.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vocabulary_terms_user_term
    ON vocabulary_terms (user_id, lower(btrim(term)));

-- The read that runs on every upload: all active terms for one user.
CREATE INDEX IF NOT EXISTS idx_vocabulary_terms_user_active
    ON vocabulary_terms (user_id, active, category);

CREATE TABLE IF NOT EXISTS known_speakers (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    display_name  TEXT NOT NULL,
    times_used    INTEGER NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_known_speakers_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_known_speakers_times_used CHECK (times_used >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_known_speakers_user_name
    ON known_speakers (user_id, lower(btrim(display_name)));

-- Suggestion order: most used first, then most recent.
CREATE INDEX IF NOT EXISTS idx_known_speakers_user_rank
    ON known_speakers (user_id, times_used DESC, last_used_at DESC);

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
-- Both tables carry user_id directly, so they take the same tenant_isolation
-- policy as the other user-owned tables. FORCE matters here for the same reason
-- it did in V9: the app connects as the table owner, and Postgres exempts an
-- owner from its own policies unless forced.
DO $$
DECLARE
    t text;
    owned text[] := ARRAY['vocabulary_terms', 'known_speakers'];
BEGIN
    FOREACH t IN ARRAY owned LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        -- Ownership is the only test. V11 dropped app_is_system(): the system
        -- exemption is BYPASSRLS on the recallix_sys connection, not a flag a
        -- policy consults, precisely so that arbitrary SQL cannot switch it on.
        -- Referencing it here is what made this migration fail to apply at all.
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
                FOR ALL
                USING      (user_id = app_current_user())
                WITH CHECK (user_id = app_current_user())
        $p$, t);
    END LOOP;
END $$;

COMMENT ON TABLE vocabulary_terms IS
    'Per-user transcription boosting hints: keywords, names, jargon, acronyms.';
COMMENT ON TABLE known_speakers IS
    'Names a user has applied to diarized speakers before, offered as rename suggestions.';
