CREATE TABLE IF NOT EXISTS human_intro_fields (
  participant_id TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, project, field)
);

CREATE TABLE IF NOT EXISTS human_intro_suggestions (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_intro_pending ON human_intro_suggestions (participant_id, resolved_at);

CREATE TABLE IF NOT EXISTS human_intro_profile_notices (
  notification_id TEXT PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES participants(id)
);

CREATE TABLE IF NOT EXISTS human_intro_notices (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  new_role TEXT,
  new_responsibility TEXT
);
