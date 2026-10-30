-- One-time backfill for boards that existed before the change log: rebuild what the
-- task rows still remember (created, started, done, deleted). Safe to run twice.
INSERT INTO task_events (task_id, at, kind, detail)
SELECT id, created_at, 'created', json_object('title', title, 'tag', tag, 'date', date) FROM tasks
WHERE NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = tasks.id);

INSERT INTO task_events (task_id, at, kind, detail)
SELECT id, started_at, 'started', NULL FROM tasks
WHERE started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = tasks.id AND e.kind = 'started');

INSERT INTO task_events (task_id, at, kind, detail)
SELECT id, done_at, 'done', NULL FROM tasks
WHERE done_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = tasks.id AND e.kind = 'done');

INSERT INTO task_events (task_id, at, kind, detail)
SELECT id, updated_at, 'deleted', NULL FROM tasks
WHERE deleted = 1 AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = tasks.id AND e.kind = 'deleted');
