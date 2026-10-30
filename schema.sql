CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT 'todo',
  url TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  date TEXT,
  carried INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL,
  checklist TEXT,
  started_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_rev ON tasks (rev);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Append-only change log, one row per field change, written by /api/sync. Powers the History tab.
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS task_events_at ON task_events (at);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, at);
