-- 知識庫上層：AI 寫的知識頁（有價值，重寫要花 token）
-- 不需核准：status 只用 published／stale；reviewed_by、reviewed_at 先保留，之後要加核准流程時用
-- docs 加整理排程：kb_org＝todo（排在整理卡裡、還沒寫頁）；kb_card＝哪張整理卡（cards.seq）
CREATE TABLE IF NOT EXISTS kb_pages (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, author_id TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT, card_id TEXT, notices TEXT NOT NULL DEFAULT '[]', stale_note TEXT, stale_at TEXT, update_card INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT);
CREATE INDEX IF NOT EXISTS idx_kb_pages ON kb_pages (project, status, deleted_at);
ALTER TABLE docs ADD COLUMN kb_org TEXT;
ALTER TABLE docs ADD COLUMN kb_card INTEGER;
