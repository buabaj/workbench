-- Let a workspace leave the recents list without losing its history.
--
-- Deleting the row is the obvious implementation and the wrong one: tasks,
-- checkpoints, links and anchors all reference workspaces ON DELETE CASCADE,
-- so "remove from this list" would silently destroy every conversation and
-- every restore point for that project.
ALTER TABLE workspaces ADD COLUMN forgotten_at INTEGER;
