import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT    NOT NULL,
  role                 TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  display_name         TEXT,
  fee_pct              REAL    NOT NULL DEFAULT 0,
  telegram_chat_id     TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  last_login_at        TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Cartera cripto actual de cada usuario (una por usuario; los cambios quedan en audit_log).
CREATE TABLE IF NOT EXISTS wallets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  asset      TEXT    NOT NULL,
  network    TEXT    NOT NULL,
  address    TEXT    NOT NULL,
  memo       TEXT,
  -- Nombre de la direccion dada de alta en Kraken (Funding > Withdraw). Kraken solo
  -- permite retirar por API a direcciones previamente guardadas alli.
  kraken_key TEXT,
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_object_id TEXT    NOT NULL UNIQUE,
  stripe_event_id  TEXT,
  source           TEXT    NOT NULL DEFAULT 'stripe',
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  gross_cents      INTEGER NOT NULL,
  fee_cents        INTEGER NOT NULL DEFAULT 0,
  net_cents        INTEGER NOT NULL,
  currency         TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'succeeded'
                     CHECK (status IN ('succeeded','refunded','disputed','canceled')),
  description      TEXT,
  customer_email   TEXT,
  metadata_json    TEXT,
  payout_id        INTEGER REFERENCES payouts(id) ON DELETE SET NULL,
  paid_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_user  ON payments(user_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_payments_open  ON payments(user_id, payout_id) WHERE payout_id IS NULL;

CREATE TABLE IF NOT EXISTS payouts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_date      TEXT    NOT NULL,
  amount_cents     INTEGER NOT NULL,
  currency         TEXT    NOT NULL,
  asset            TEXT    NOT NULL,
  network          TEXT,
  address          TEXT    NOT NULL,
  kraken_key       TEXT,
  quote_price      REAL,
  volume           REAL,
  kraken_order_txid TEXT,
  kraken_refid     TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','trading','withdrawing','sent','failed')),
  error            TEXT,
  simulated        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payouts_user ON payouts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  processed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT    NOT NULL DEFAULT 'telegram',
  target     TEXT,
  text       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'sent',
  error      TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,
  entity        TEXT,
  entity_id     TEXT,
  details_json  TEXT,
  ip            TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

/** Cierra todas las sesiones abiertas de un usuario (al desactivarlo o cambiarle la contrasena). */
export function destroySessionsForUser(userId) {
  const rows = db.prepare('SELECT sid, data FROM sessions').all();
  const remove = db.prepare('DELETE FROM sessions WHERE sid = ?');
  let n = 0;
  for (const row of rows) {
    try {
      if (JSON.parse(row.data)?.userId === userId) {
        remove.run(row.sid);
        n += 1;
      }
    } catch {
      remove.run(row.sid); // sesion ilegible: fuera
    }
  }
  return n;
}

export function audit(actorUserId, action, { entity, entityId, details, ip } = {}) {
  db.prepare(
    `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details_json, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    actorUserId ?? null,
    action,
    entity ?? null,
    entityId == null ? null : String(entityId),
    details ? JSON.stringify(details) : null,
    ip ?? null
  );
}

export default db;
