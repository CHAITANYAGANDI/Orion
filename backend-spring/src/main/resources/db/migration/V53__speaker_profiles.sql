-- Voice identity: the storage Recallix deliberately did not have until now.
--
-- V20 created `known_speakers`, and it is worth being precise about what that
-- table was, because its name invited exactly the misreading this migration has
-- to avoid. It held a display name, a use count and a last-used date. Nothing
-- else. It was an autocomplete list — it made typing "Sarah" for the fourth
-- time quicker — and it could not have identified anybody, because a name is
-- not a voice. It was dropped in V51 along with the rest of that feature.
--
-- "Rematch speakers", as users understand it from other products, is the claim
-- that an unresolved Speaker 2 in a recording from March can be recognised as
-- the Sarah who was tagged in a recording from January. There is exactly one
-- honest way to do that and it is acoustic: compare a representation of the
-- voice. Everything else that looks like it would work is a guess wearing a
-- confident face —
--
--   * speaker numbers do not carry across meetings. They are assigned by who
--     spoke first, so Speaker 2 in March and Speaker 2 in January are related
--     only by the accident of who cleared their throat first;
--   * the provider's cluster labels ("A", "D") are per-request identifiers and
--     are explicitly documented as meaningless across files;
--   * reading the transcript for "thanks, Sarah" identifies who was *spoken
--     to*, not who was speaking, and gets the answer backwards as often as not;
--   * asking a language model whose voice it was asks a system that has never
--     heard the audio, and it will answer anyway.
--
-- So this migration introduces the one thing that can actually do the job, and
-- it is the most sensitive data in the product.
--
-- ==========================================================================
-- WHAT AN EMBEDDING IS, AND WHY IT IS TREATED AS BIOMETRIC
-- ==========================================================================
-- A 192-number vector from ECAPA-TDNN describing how a voice sounds, not what
-- it said. It cannot be turned back into audio and it contains no words.
--
-- That is not a reason to relax. It is a stable identifier derived from a
-- person's body, it is the thing that makes one recording of them linkable to
-- every other, and under GDPR Article 9 a template used to identify a natural
-- person is biometric data whether or not it is reversible. It is therefore
-- handled as such throughout, and the boundary is written down here rather than
-- left to be inferred from the code.
--
-- ==========================================================================
-- THE FIVE RULES
-- ==========================================================================
-- 1. NOTHING IS STORED WITHOUT CONSENT. `users.speaker_learning_enabled`
--    defaults to FALSE. Every account that exists when this migration runs has
--    it off, and it can only be turned on by the account holder, in Settings,
--    reading a description of what it does. No embedding is computed — not
--    stored, not computed — while it is off.
--
-- 2. A PROFILE ONLY EXISTS BECAUSE A HUMAN NAMED SOMEBODY. There is no
--    background enrolment. `speaker_profiles` gains a row when the user renames
--    a speaker to a real name, which is an act that already means "this is who
--    that is". Automatic identification never creates or updates a profile,
--    only reads them, so the system cannot bootstrap itself off its own guesses.
--
-- 3. THE VECTOR IS ENCRYPTED AT REST. `embedding` is BYTEA holding AES
--    ciphertext (Fernet: AES-128-CBC + HMAC-SHA256), not a pgvector column.
--    That is a deliberate trade: a `vector(192)` column would let Postgres do
--    the nearest-neighbour search, but it would also mean the templates sit in
--    the database in directly usable form, readable by anything holding a
--    connection or a base backup. Matching happens in the ai-service instead,
--    over a handful of decrypted vectors held in memory for the length of one
--    request. The search is linear; a user has tens of profiles, not millions,
--    so this costs nothing and buys the property that the key and the data are
--    not in the same place. Without SPEAKER_PROFILE_KEY set, the feature is off.
--
-- 4. ONE ACCOUNT, ONE SET OF VOICES. Both tables carry `user_id`, both are
--    under FORCEd row-level security, and there is no cross-account read
--    anywhere in the product. Profiles are never pooled, shared, aggregated, or
--    used to improve anything for anyone else. Sarah in one account and the
--    same Sarah in another are two unrelated rows that never meet.
--
-- 5. IT LEAVES WHEN ASKED, AND WHEN IMPLIED. Deleting one profile deletes the
--    template. Turning speaker learning off deletes every profile and every
--    voiceprint the account holds — withdrawal of consent removes the data, not
--    merely the use of it. Deleting a meeting takes its voiceprints (CASCADE),
--    and erasing a recording erases the voiceprints derived from it, because a
--    request to remove somebody's voice that left a template of it behind would
--    be a lie by omission.
--
-- Two things are NOT claimed, and should not be read into the above. The
-- ciphertext protects the vector at rest and in backups; it does not protect it
-- from an attacker who already has the running service's memory or its key.
-- And there is no key rotation here — re-keying means re-enrolling, which is
-- the honest position for a first version rather than a rotation scheme that
-- has never been exercised.

-- --------------------------------------------------------------------------
-- Consent
-- --------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS speaker_learning_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.speaker_learning_enabled IS
    'Opt-in to storing voice templates for the people this user names in their meetings. '
    'FALSE for every existing account and for every new one. While FALSE no embedding is '
    'computed or stored, and turning it back to FALSE deletes everything already held.';

-- --------------------------------------------------------------------------
-- The voices a user has named
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS speaker_profiles (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    display_name  TEXT NOT NULL,
    -- Fernet ciphertext of a 192-float vector. Never a bare vector; see rule 3.
    embedding     BYTEA NOT NULL,
    -- How many separately-named appearances have been averaged into it. Shown
    -- in Settings so "why did it match?" has an answer the user can act on: a
    -- profile built from one short turn is one they may want to delete.
    sample_count  INTEGER NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_speaker_profiles_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_speaker_profiles_samples CHECK (sample_count >= 1)
);

-- One profile per person per account. Case-folded because "sarah" and "Sarah"
-- are the same colleague, and two profiles for one voice is the state in which
-- neither can ever win the ambiguity margin — the feature would quietly stop
-- working, in the way that looks like it never worked.
CREATE UNIQUE INDEX IF NOT EXISTS uq_speaker_profiles_user_name
    ON speaker_profiles (user_id, lower(btrim(display_name)));
CREATE INDEX IF NOT EXISTS idx_speaker_profiles_user
    ON speaker_profiles (user_id, updated_at DESC);

COMMENT ON TABLE speaker_profiles IS
    'Biometric-adjacent. One encrypted voice template per person the account holder has '
    'explicitly named. Created only by a manual rename, never by automatic identification.';
COMMENT ON COLUMN speaker_profiles.embedding IS
    'Fernet-encrypted ECAPA-TDNN speaker embedding (192 floats). Never logged, never shared '
    'across accounts, never used to train anything.';

-- --------------------------------------------------------------------------
-- Per-meeting voiceprints
-- --------------------------------------------------------------------------
-- One vector per canonical speaker per meeting: the raw material both halves of
-- the feature need. Naming a speaker copies theirs into a profile; rematching
-- compares the unresolved ones against every profile.
--
-- Cached rather than recomputed because the alternative is downloading and
-- decoding an hour of audio every time somebody presses a menu item — and
-- because a recording can be erased while the meeting stays, which would
-- otherwise make rematch stop working on exactly the older meetings it is for.
-- The cache is keyed on `speaker_key`, the meeting-local identity that survives
-- renames, so a voiceprint stays attached to the right voice no matter what the
-- turn is currently labelled.
CREATE TABLE IF NOT EXISTS meeting_speaker_voiceprints (
    id             TEXT PRIMARY KEY,
    meeting_id     TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    speaker_key    TEXT NOT NULL,
    embedding      BYTEA NOT NULL,
    -- How much speech went into it. The matcher refuses a candidate built from
    -- too little audio, and it needs to know that here rather than re-deriving
    -- it from segments that may since have been edited.
    speech_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_voiceprint_speaker_key CHECK (length(btrim(speaker_key)) BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_voiceprints_meeting_speaker
    ON meeting_speaker_voiceprints (meeting_id, speaker_key);
CREATE INDEX IF NOT EXISTS idx_voiceprints_user
    ON meeting_speaker_voiceprints (user_id);

COMMENT ON TABLE meeting_speaker_voiceprints IS
    'Biometric-adjacent. One encrypted voice template per canonical speaker per meeting, '
    'computed only while the owner has speaker learning switched on. Deleted with the '
    'meeting, with the recording it came from, and when learning is switched off.';

-- --------------------------------------------------------------------------
-- Tenant isolation
-- --------------------------------------------------------------------------
-- Same shape as every other user-owned table since V9: the policy is the
-- database's, not the application's, so a repository method that forgets its
-- ownership check returns nothing rather than somebody else's voice. FORCE
-- because both this application and Flyway connect as the table owner, and
-- Postgres exempts an owner from its own policies without it — which would
-- leave this looking protected and enforcing nothing.
--
-- No app_is_system() clause on either table, unlike `outbox` or `meetings`.
-- Nothing in Recallix has a legitimate reason to read voice templates outside a
-- request belonging to the person they describe: there is no nightly job over
-- them, no admin view, no support path. Omitting the bypass means no future
-- endpoint can acquire one by accident.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['speaker_profiles', 'meeting_speaker_voiceprints'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (user_id = app_current_user()) '
            'WITH CHECK (user_id = app_current_user())', t);
    END LOOP;
END $$;
