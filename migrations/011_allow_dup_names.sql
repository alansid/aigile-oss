-- 拿掉 participants.name 的全站 UNIQUE（同專案不可同名由應用層檢查，不同專案可同名）
CREATE TABLE _participants_dup_tmp (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT '',
  role_key TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE,
  owner_id TEXT,
  duties TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  autonomy TEXT NOT NULL DEFAULT '',
  must_confirm TEXT NOT NULL DEFAULT '',
  handoff TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  avatar_v INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL UNIQUE,
  token_expires_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  is_admin INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  standby_at INTEGER NOT NULL DEFAULT 0,
  wake_day TEXT NOT NULL DEFAULT '',
  wake_count INTEGER NOT NULL DEFAULT 0,
  wake_at INTEGER NOT NULL DEFAULT 0,
  projects TEXT NOT NULL DEFAULT ''
);
INSERT INTO _participants_dup_tmp (id, kind, name, role, role_key, code, owner_id, duties, style, autonomy, must_confirm, handoff, avatar, avatar_v, token, token_expires_at, status, is_admin, version, created_at, updated_at, last_seen_at, standby_at, wake_day, wake_count, wake_at, projects)
SELECT id, kind, name, role, role_key, code, owner_id, duties, style, autonomy, must_confirm, handoff, avatar, avatar_v, token, token_expires_at, status, is_admin, version, created_at, updated_at, last_seen_at, standby_at, wake_day, wake_count, wake_at, projects FROM participants;
DROP TABLE participants;
ALTER TABLE _participants_dup_tmp RENAME TO participants;
CREATE INDEX IF NOT EXISTS idx_participants_seen ON participants (last_seen_at);
CREATE INDEX IF NOT EXISTS idx_participants_owner ON participants (owner_id);
CREATE INDEX IF NOT EXISTS idx_participants_name ON participants (name);
