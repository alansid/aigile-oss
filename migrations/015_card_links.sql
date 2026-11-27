-- 卡片關聯（前置卡、關聯卡）：blocked_by＝from 要等 to 做完；related 存成 from_seq < to_seq、不分方向。不改現有的表
CREATE TABLE IF NOT EXISTS card_links (
  from_seq INTEGER NOT NULL REFERENCES cards(seq),
  to_seq INTEGER NOT NULL REFERENCES cards(seq),
  kind TEXT NOT NULL CHECK (kind IN ('blocked_by', 'related')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_seq, to_seq)
);
CREATE INDEX IF NOT EXISTS idx_card_links_to ON card_links (to_seq);
