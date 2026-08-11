-- Remove Meeting Memory and Agent Actions.
--
-- Meeting Memory was the commitment ledger: action items promoted into
-- promises, then judged against every later meeting for evidence they had been
-- kept, slipped or cancelled. Its other half, decision drift, went in V14.
-- Action items themselves are untouched — they are a meeting's own output, not
-- part of the ledger built on top of them.
--
-- Agent Actions was the plan/approve/execute flow over connected tools.
--
-- `agent_connections` is deliberately NOT dropped: the Integrations page still
-- lets a user connect and disconnect a provider, so the table still has a
-- reader. It simply has no consumer for what it stores until something replaces
-- the agent.
--
-- Destructive and deliberate, matching V14: dropping is what was asked for,
-- rather than leaving tables behind that no code references. Restoring the
-- ledger would mean re-processing every meeting.

DROP TABLE IF EXISTS commitment_evidence;
DROP TABLE IF EXISTS commitments;
DROP TABLE IF EXISTS agent_action_requests;
