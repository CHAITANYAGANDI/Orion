-- Two more things a person can say about themselves on the profile.
--
-- pronouns: free text, not an enum. Every fixed list is wrong for somebody, and
-- the field exists precisely so a person can be described the way they ask to
-- be rather than the way a schema guessed. Short, because it holds "she/her",
-- not a sentence.
--
-- avatar: the image itself, as a data URL, rather than a key into object
-- storage. It is displayed on every page, and a presigned URL would either
-- expire while somebody was reading or force a public bucket. It is downscaled
-- to 256px client-side before it is sent and capped server-side, so the column
-- holds tens of kilobytes for one row per user -- not per meeting, which is
-- what would have made this the wrong call.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns   VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
