-- Starring a folder, and making "last updated" mean what the column says.
--
-- WHY A STAR AT ALL
--   The rail lists every folder a workspace has, alphabetically, and at twenty
--   of them the two somebody is actually working in are somewhere in the middle
--   of the list. A star is the cheapest possible fix: one boolean, one sort key,
--   no hierarchy, no pinned-order to keep in step. It is deliberately not a
--   second grouping — a starred folder is the same folder, listed first.
--
-- WHY NOT AN INDEX
--   MAX_PROJECTS is 200 and the list is already read in full to attach meeting
--   counts. An index on a boolean over two hundred rows costs more to maintain
--   than the sort it would save.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN projects.favorite IS
    'Starred: sorted to the top of the folder list and the sidebar. Not a second grouping.';

-- WHAT `updated_at` NOW MEANS
--   It was the row's own last write — a rename or a colour change — which made
--   the "Last Updated" column in the folder list quietly wrong: filing three
--   meetings into a folder left it reading as untouched since the day it was
--   named. ProjectService now stamps the folder when a meeting is filed into or
--   out of it, so the column means "when did anything about this folder change",
--   which is the only reading anybody takes from it.
--
--   Existing rows are backfilled from what is in them: the newest meeting a
--   folder holds is the last time it demonstrably changed. Folders holding
--   nothing keep the timestamp they have.
UPDATE projects p
   SET updated_at = GREATEST(p.updated_at, m.newest)
  FROM (SELECT project_id, MAX(created_at) AS newest
          FROM meetings
         WHERE project_id IS NOT NULL
         GROUP BY project_id) m
 WHERE m.project_id = p.id;

COMMENT ON COLUMN projects.updated_at IS
    'Last time anything about this folder changed, including a meeting being filed into or out of it.';
