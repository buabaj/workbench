-- A short, human title for a conversation.
--
-- The sessions list derived its label from tasks.prompt_text, which holds the
-- COMPOSED message — mode templates and all — so every conversation started
-- in the same mode showed the same first 80 characters and the list read as
-- a column of duplicates. Titles are generated from the real exchange instead.
ALTER TABLE tasks ADD COLUMN title TEXT;
