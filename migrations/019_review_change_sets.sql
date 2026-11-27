CREATE TABLE IF NOT EXISTS review_change_parts (
  card_seq INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  file_index INTEGER NOT NULL,
  part INTEGER NOT NULL,
  lines TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (card_seq, round_id, file_index, part)
);
CREATE INDEX IF NOT EXISTS idx_review_change_expiry ON review_change_parts (expires_at);
CREATE TABLE IF NOT EXISTS review_change_sets (
  card_seq INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  PRIMARY KEY (card_seq, round_id)
);
