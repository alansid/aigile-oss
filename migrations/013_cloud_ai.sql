-- 雲端 AI（第一階段）：模型設定、每隻雲端 AI 的設定、每輪用量。不改現有的表
CREATE TABLE IF NOT EXISTS model_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- gemini | openai | anthropic | ollama | custom
  url TEXT NOT NULL,
  key_enc TEXT NOT NULL DEFAULT '',         -- 用主密鑰 AES-GCM 加密後的金鑰；空＝不需要金鑰
  key_last4 TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]',        -- 勾選給 AI 用的模型（JSON 陣列）
  status TEXT NOT NULL DEFAULT 'untested',  -- untested | ok | key_error | quota | unreachable | model_error | error
  last_test TEXT NOT NULL DEFAULT '',
  last_test_at INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER NOT NULL DEFAULT 0,   -- 出錯已通知管理員（同一組只通知一次，測試連線成功後歸零）
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_agents (
  ai_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  model TEXT NOT NULL,
  max_tools INTEGER NOT NULL DEFAULT 20,
  max_tokens INTEGER NOT NULL DEFAULT 50000,
  state TEXT NOT NULL DEFAULT 'ready',      -- ready | retry | error（叫不醒）
  state_note TEXT NOT NULL DEFAULT '',
  pending INTEGER NOT NULL DEFAULT 0,       -- 跑的時候又被叫醒：這輪結束再跑一輪
  updated_at INTEGER NOT NULL DEFAULT 0,
  token_enc TEXT NOT NULL DEFAULT ''           -- 這隻 AI 的 Token 原文（用主密鑰加密；資料表只存雜湊，伺服器替它打 API 時用）
);
CREATE INDEX IF NOT EXISTS idx_cloud_agents_conn ON cloud_agents (connection_id);
CREATE TABLE IF NOT EXISTS cloud_runs (
  id TEXT PRIMARY KEY,
  ai_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  tools INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT 'running',   -- running | replied | idle | limit | error
  note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',           -- 跑到一半的對話（JSON）；結束清空
  lease_until INTEGER NOT NULL DEFAULT 0,   -- 有程式正在跑這一步
  retry_at INTEGER NOT NULL DEFAULT 0,      -- 連不到時排定的重試時間
  retries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cloud_runs_ai ON cloud_runs (ai_id, started_at);
CREATE INDEX IF NOT EXISTS idx_cloud_runs_result ON cloud_runs (result, lease_until);
