ALTER TABLE launcher_folders ADD COLUMN generation TEXT NOT NULL DEFAULT 'legacy';
CREATE TABLE IF NOT EXISTS launcher_folder_removals (
  id TEXT PRIMARY KEY,
  launcher_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  generation TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  confirmed_ais TEXT NOT NULL,
  completed_at INTEGER,
  synced_at INTEGER,
  UNIQUE (launcher_id, folder, generation)
);
CREATE INDEX IF NOT EXISTS idx_launcher_folder_sync ON launcher_folder_removals (launcher_id, synced_at);

ALTER TABLE launcher_jobs ADD COLUMN stop_hash TEXT;
ALTER TABLE launcher_jobs ADD COLUMN stop_requested_at INTEGER;
