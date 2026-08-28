-- Rewrites the product name inside comments stored ON the database objects.
--
-- The rename swept the whole repository, but three strings escaped it because
-- they are not source text any more. V34, V35 and V52 each ran a
-- `COMMENT ON ... IS '...Recallix...'`, so the name was copied into pg_description
-- when those migrations applied and now lives in the database rather than in a
-- file. Editing those migrations would change their checksums and stop the
-- backend booting; editing the database is what actually moves them.
--
-- These are documentation, not behaviour -- they surface in \d+, in
-- information_schema, and in whatever a schema browser shows someone trying to
-- understand the model. Which is exactly why they are worth correcting: a
-- column comment is read by the next person wondering what `auto_title` means,
-- and a stale product name there is a small lie in the place someone goes
-- specifically to stop being confused.
--
-- Done as a loop over pg_description rather than as three hand-written
-- statements. The text is long, and retyping it to change one word is how a
-- sentence quietly loses a clause; `replace` cannot. It also means this catches
-- any comment the sweep missed, including ones added between writing this and
-- running it.
--
-- Idempotent: after it runs nothing matches, so a second run does nothing.

DO $$
DECLARE
    target record;
    fixed  text;
BEGIN
    -- Column comments.
    FOR target IN
        SELECT c.relname AS table_name,
               a.attname AS column_name,
               d.description
          FROM pg_description d
          JOIN pg_class     c ON c.oid = d.objoid
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
         WHERE c.relnamespace = 'public'::regnamespace
           AND d.objsubid > 0
           AND d.description ILIKE '%recallix%'
    LOOP
        fixed := replace(replace(target.description, 'Recallix', 'Orion'),
                         'recallix', 'orion');
        -- format() with %I and %L rather than string concatenation: the
        -- comment bodies contain apostrophes ("you were not looking"), and
        -- quoting those by hand is the whole reason this is not three
        -- COMMENT ON statements.
        EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L',
                       target.table_name, target.column_name, fixed);
        RAISE NOTICE 'Rewrote comment on %.%', target.table_name, target.column_name;
    END LOOP;

    -- Table comments.
    FOR target IN
        SELECT c.relname AS table_name,
               d.description
          FROM pg_description d
          JOIN pg_class c ON c.oid = d.objoid
         WHERE c.relnamespace = 'public'::regnamespace
           AND d.objsubid = 0
           AND c.relkind = 'r'
           AND d.description ILIKE '%recallix%'
    LOOP
        fixed := replace(replace(target.description, 'Recallix', 'Orion'),
                         'recallix', 'orion');
        EXECUTE format('COMMENT ON TABLE public.%I IS %L', target.table_name, fixed);
        RAISE NOTICE 'Rewrote comment on table %', target.table_name;
    END LOOP;
END $$;
