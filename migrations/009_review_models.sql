-- 審查者要多不一樣：記下每位 AI 回報的模型。只新增欄位與資料表
-- card_reviews.model：做這件事的 AI 當時回報的模型（人或沒回報＝NULL）
ALTER TABLE card_reviews ADD COLUMN model TEXT;
-- card_reviews.tool 改記「做這件事的 AI」當時的工具（送審＝作者）；之前送審列記的是審查者的工具，作者的不知道，清成不明（比對時當作不一樣）
UPDATE card_reviews SET tool = NULL WHERE ev = 'request';
-- 每隻 AI 最近一次回報的模型：接上（aigile_use／aigile_me／接入檢查）、送審、回覆審查時由 AI 自己帶；被叫醒不回報
CREATE TABLE IF NOT EXISTS ai_models (
  ai_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,                 -- AI 回報的完整模型代號（例：claude-opus-5-5）
  via TEXT NOT NULL,                   -- checkin 接上／request 送審／review 審查
  at TEXT NOT NULL
);
