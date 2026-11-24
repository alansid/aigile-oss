CREATE TABLE IF NOT EXISTS card_attachments (
  doc_id TEXT PRIMARY KEY REFERENCES docs(id),
  card_seq INTEGER NOT NULL REFERENCES cards(seq),
  note_id INTEGER REFERENCES card_log(id),
  human_only INTEGER NOT NULL DEFAULT 0 CHECK (human_only IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_card_attachments_card ON card_attachments(card_seq);
