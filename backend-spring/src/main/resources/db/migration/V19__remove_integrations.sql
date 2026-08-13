-- Remove the integrations feature.
--
-- `agent_connections` is the last of the Phase 2 agent scaffold. V15 dropped
-- the parts that acted — `agent_action_requests`, `commitments`,
-- `commitment_evidence` — but deliberately kept this table, because the
-- integrations page still listed connectable apps. That page is now gone too,
-- so nothing reads or writes this.
--
-- It only ever held connection stubs: no provider OAuth was implemented, so no
-- row ever carried a token or reached an external service.

DROP TABLE IF EXISTS agent_connections;
