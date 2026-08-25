-- Keep retired events out of the index the relay reads on every tick.
--
-- `idx_outbox_unpublished` has been `WHERE published = false` since V1, which
-- was exactly right when the only two states were pending and published. V59
-- added a third: an event retired as unpublishable keeps `published = false`
-- forever, so it stays in this index forever -- and, by design, the published-row
-- purge in V62's job will never remove it either.
--
-- The claim query already excludes those rows with `failed_at IS NULL`, so they
-- were being read from the index and then discarded on every claim. Narrowing
-- the index predicate to match the query means they are never read at all.
--
-- MEASURED, NOT ASSUMED
--
-- Against 20000 rows (19500 published, 250 pending, 250 retired) the plan shape
-- is identical either way -- Hash Anti Join over two index scans -- and the win
-- is small but real: the two `Rows Removed by Filter: 250` steps disappear and
-- shared buffers fall from 536 to 502 across the two scans. At today's volumes
-- that is nothing.
--
-- The reason to do it anyway is not the 6%. It is that retired rows are the one
-- category that accumulates without bound: pending rows drain, published rows
-- are purged, retired rows are kept deliberately and forever. An index on the
-- hot path should not have a term in it that only ever grows.

CREATE INDEX IF NOT EXISTS idx_outbox_claimable
    ON outbox_events (published)
    WHERE published = false AND failed_at IS NULL;

DROP INDEX IF EXISTS idx_outbox_unpublished;

COMMENT ON INDEX idx_outbox_claimable IS
    'Covers the relay claim query. Predicate matches what "claimable" means: not published and not retired.';
