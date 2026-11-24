-- 拿掉 participants.name 的全站 UNIQUE（同專案不可同名由應用層檢查，不同專案可同名）。PostgreSQL 版（對應 migrations/011_allow_dup_names.sql）。
ALTER TABLE participants DROP CONSTRAINT IF EXISTS participants_name_key;
CREATE INDEX IF NOT EXISTS idx_participants_name ON participants (name);
