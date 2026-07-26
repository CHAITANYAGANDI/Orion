-- Meeting Memory: commitment ledger + decision drift.
--
-- Both features answer questions that span meetings, which is only possible
-- because every transcript is embedded in one space (V2/V3):
--
--   * Commitment ledger — an action item is a promise made at a point in time.
--     Every later meeting is evidence about whether it was kept. `commitments`
--     is the promise; `commitment_evidence` is the audit trail of what each
--     later meeting said about it.
--
--   * Decision drift — decisions made weeks apart can quietly contradict each
--     other. `decision_vectors` embeds every decision so near-duplicates can be
--     found by ANN; `decision_links` records the adjudicated relationship.

-- 1) Commitment ledger -------------------------------------------------------
CREATE TABLE IF NOT EXISTS commitments (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The action item this was promoted from. Kept nullable: deleting the source
    -- item should not erase the historical record that the promise was made.
    action_item_id    TEXT REFERENCES meeting_action_items(id) ON DELETE SET NULL,
    origin_meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    text              TEXT NOT NULL,
    owner_name        TEXT,
    due_date          TEXT,
    -- OPEN | FULFILLED | SLIPPED | CANCELLED | DROPPED
    -- DROPPED = never mentioned again across several later meetings.
    status            TEXT NOT NULL DEFAULT 'OPEN',
    -- How many later meetings have been reconciled against this commitment.
    checks_run        INTEGER NOT NULL DEFAULT 0,
    last_checked_at   TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_commitments_origin ON commitments(origin_meeting_id);
-- One commitment per action item; makes promotion idempotent across reprocesses.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commitments_action_item
    ON commitments(action_item_id) WHERE action_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commitment_evidence (
    id            TEXT PRIMARY KEY,
    commitment_id TEXT NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
    meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    -- FULFILLED | SLIPPED | RESTATED | CANCELLED
    verdict       TEXT NOT NULL,
    rationale     TEXT,
    quote         TEXT,
    start_time    DOUBLE PRECISION,
    confidence    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A meeting yields at most one verdict per commitment, so re-reconciling the
-- same meeting overwrites rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_unique
    ON commitment_evidence(commitment_id, meeting_id);
CREATE INDEX IF NOT EXISTS idx_evidence_commitment
    ON commitment_evidence(commitment_id, created_at);

-- 2) Decision drift ----------------------------------------------------------
-- Embeddings live in their own table rather than as a column on
-- meeting_decisions, which JPA owns and which has no pgvector mapping.
CREATE TABLE IF NOT EXISTS decision_vectors (
    decision_id TEXT PRIMARY KEY REFERENCES meeting_decisions(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    embedding   vector(1536),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decision_vectors_user ON decision_vectors(user_id);
CREATE INDEX IF NOT EXISTS idx_decision_vectors_embedding
    ON decision_vectors USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS decision_links (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    earlier_decision_id TEXT NOT NULL REFERENCES meeting_decisions(id) ON DELETE CASCADE,
    later_decision_id   TEXT NOT NULL REFERENCES meeting_decisions(id) ON DELETE CASCADE,
    -- CONTRADICTS | SUPERSEDES | REAFFIRMS
    relation            TEXT NOT NULL,
    rationale           TEXT,
    similarity          DOUBLE PRECISION,
    -- Set once the user has seen and dismissed the flag.
    acknowledged        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_links_pair
    ON decision_links(earlier_decision_id, later_decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_links_user
    ON decision_links(user_id, acknowledged, created_at);
