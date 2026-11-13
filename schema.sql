-- ERP RPA (Rumah Potong Ayam) — skema D1
-- Semua transaksi & master disimpan sebagai "record" per jenis (kind).
-- Laporan (stok, HPP, jurnal, neraca) DIHITUNG dari record, bukan disimpan,
-- jadi edit transaksi otomatis memperbarui semua laporan.

CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- unit, item, partner, vehicle, account, po, gr, prod, so, cash, jv, setting
  unit_id     TEXT,                   -- unit usaha (multi-bisnis)
  date        TEXT,                   -- YYYY-MM-DD
  no          TEXT,                   -- nomor dokumen (PO-2611-0001)
  status      TEXT,
  data        TEXT NOT NULL,          -- JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  created_by  TEXT,
  updated_by  TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind, deleted);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_no ON records(kind, no) WHERE no IS NOT NULL;

-- Jejak audit: siapa mengubah apa & kapan
CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  TEXT NOT NULL,
  kind       TEXT,
  action     TEXT NOT NULL,           -- create, update, delete, import
  data       TEXT,
  at         TEXT NOT NULL,
  by_user    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit(record_id);
