CREATE TABLE IF NOT EXISTS launchers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_launchers_owner ON launchers (owner_id, revoked_at);
CREATE TABLE IF NOT EXISTS launcher_pair_codes (
  code TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ai_id TEXT,
  tool TEXT,
  browser_hash TEXT,
  used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_launcher_browser_hash ON launcher_pair_codes(browser_hash) WHERE browser_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS launcher_regs (
  launcher_id TEXT NOT NULL,
  ai_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  folder TEXT NOT NULL,
  tool TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (launcher_id, ai_id)
);
CREATE INDEX IF NOT EXISTS idx_launcher_regs_ai ON launcher_regs (ai_id);
CREATE TABLE IF NOT EXISTS launcher_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  ai_id TEXT NOT NULL,
  launcher_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  window_closed_at INTEGER,
  setup_claimed_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_launcher_jobs_owner ON launcher_jobs (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_launcher_jobs_launcher ON launcher_jobs (launcher_id, status, created_at);

CREATE TABLE IF NOT EXISTS launcher_pair_failures (
  ip_key TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launcher_pair_failure_time ON launcher_pair_failures(failed_at);
CREATE INDEX IF NOT EXISTS idx_launcher_pair_failure_ip ON launcher_pair_failures(ip_key, failed_at);
CREATE TABLE IF NOT EXISTS launcher_browser_requests (
  code_hash TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launcher_browser_created ON launcher_browser_requests(created_at);
CREATE TABLE IF NOT EXISTS launcher_folders (
  launcher_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  PRIMARY KEY (launcher_id, folder)
);

CREATE TABLE IF NOT EXISTS launcher_pair_workspaces (
  secret_hash TEXT PRIMARY KEY,
  returning_id TEXT,
  folder TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
