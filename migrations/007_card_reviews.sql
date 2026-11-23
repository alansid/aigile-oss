-- 審查者：卡片的送審、通過、要改、作廢紀錄（一列一個事件）
CREATE TABLE IF NOT EXISTS card_reviews (
  id TEXT PRIMARY KEY,
  card_seq INTEGER NOT NULL,
  project TEXT NOT NULL,
  ev TEXT NOT NULL,                    -- request 送審／pass 通過／changes 要改／void 版本變了，通過作廢
  version TEXT NOT NULL,               -- 40 碼 SHA 或 diff 指紋
  actor_id TEXT NOT NULL,              -- 做這件事的人（送審＝作者；通過／要改＝審查者；作廢＝送新版本的作者）
  reviewer_id TEXT,                    -- 這一輪的審查者
  reviewer_kind TEXT,                  -- ai／human
  tool TEXT,                           -- 審查者的 AI 工具（claude／codex…；人或不明＝NULL）
  comment TEXT NOT NULL DEFAULT '',    -- 送審說明或審查意見
  diff_file TEXT,                      -- 送審附的 diff（docs.id，存在專案文件）
  is_code INTEGER,                     -- 送審時：1＝程式卡、0＝作者改成不是程式卡
  message_id TEXT,                     -- 這一輪的送審訊息（送審、通過、要改都記；一輪＝一則送審訊息）
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_reviews_card ON card_reviews (card_seq, at);
CREATE INDEX IF NOT EXISTS idx_card_reviews_reviewer ON card_reviews (reviewer_id, ev);
-- 每一輪（送審訊息）每位審查者只算一次：併發重送的回覆也擋得住
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_reviews_vote ON card_reviews (card_seq, message_id, actor_id) WHERE ev IN ('pass', 'changes');
