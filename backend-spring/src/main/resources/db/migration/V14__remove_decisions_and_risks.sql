-- Remove the decisions and risks features.
--
-- Both were extracted from every meeting and shown on their own tabs. They are
-- gone: the extraction passes, the endpoints, the tabs, and the share/export
-- surfaces that read them.
--
-- Decision drift goes with them. It was the second half of Meeting Memory —
-- pairs of decisions made weeks apart that contradict or supersede each other —
-- and it consumed extracted decisions, so it cannot outlive them. The
-- commitment ledger, the half built on action items, is untouched.
--
-- `decision_vectors` held the embeddings that made drift candidates findable;
-- nothing else ever read it.
--
-- This is destructive and deliberate: dropping is what was asked for, rather
-- than leaving four tables behind that no code references and that a future
-- reader would have to prove were dead. Restoring the data means re-processing
-- the meetings.

DROP TABLE IF EXISTS decision_links;
DROP TABLE IF EXISTS decision_vectors;
DROP TABLE IF EXISTS meeting_decisions;
DROP TABLE IF EXISTS meeting_risks;
