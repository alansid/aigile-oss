-- PLAT-436 AI 啟動器：配對碼、已配對電腦、登記顯示同步、啟動請求與稽核紀錄
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
  used_at INTEGER
);
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
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_launcher_jobs_owner ON launcher_jobs (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_launcher_jobs_launcher ON launcher_jobs (launcher_id, status, created_at);
