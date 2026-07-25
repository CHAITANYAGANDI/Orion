-- RAG "Ask-the-meeting" chat: pgvector-backed transcript retrieval + chat history.
-- Requires the pgvector image (pgvector/pgvector:pg16).

CREATE EXTENSION IF NOT EXISTS vector;

-- Chunked, embedded transcript text. Written by the ai-service after a meeting
-- is processed; queried by the ai-service at chat time (cosine top-k).
-- Embedding dim 1536 matches OpenAI text-embedding-3-small (mock uses the same).
CREATE TABLE IF NOT EXISTS transcript_chunks (
    id           TEXT PRIMARY KEY,
    meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL,
    text         TEXT NOT NULL,
    start_time   DOUBLE PRECISION,
    end_time     DOUBLE PRECISION,
    embedding    vector(1536),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON transcript_chunks(meeting_id);
-- Approximate-NN index for cosine distance (ivfflat). Small lists is fine here.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON transcript_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Chat history per meeting (grounded Q&A). `citations_json` holds the chunks the
-- answer was grounded in (index/start/end/snippet) for the UI to link back.
CREATE TABLE IF NOT EXISTS chat_messages (
    id             TEXT PRIMARY KEY,
    meeting_id     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role           TEXT NOT NULL,               -- user | assistant
    content        TEXT NOT NULL,
    citations_json JSONB DEFAULT '[]',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_meeting ON chat_messages(meeting_id, created_at);
