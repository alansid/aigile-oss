
CREATE TABLE IF NOT EXISTS project_descriptions (
  project TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS project_preferences (
  participant_id TEXT NOT NULL, project TEXT NOT NULL,
  starred INTEGER NOT NULL DEFAULT 0, visited_at TEXT,
  PRIMARY KEY (participant_id, project)
);
