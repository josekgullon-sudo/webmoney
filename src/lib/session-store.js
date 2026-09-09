import session from 'express-session';
import db from './db.js';

const Store = session.Store;

/** Almacen de sesiones en SQLite: sobrevive a reinicios y no necesita Redis. */
export class SqliteSessionStore extends Store {
  constructor() {
    super();
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
      clear: db.prepare('DELETE FROM sessions'),
    };
    this.timer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.timer.unref?.();
  }

  prune() {
    try {
      this.stmts.prune.run(Date.now());
    } catch {
      /* la limpieza puede reintentarse en el siguiente ciclo */
    }
  }

  #expiry(sess) {
    const ms = sess?.cookie?.maxAge ?? 12 * 3600 * 1000;
    return Date.now() + ms;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.stmts.destroy.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.#expiry(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.stmts.touch.run(this.#expiry(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.stmts.destroy.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  length(cb) {
    try {
      cb(null, this.stmts.length.get(Date.now()).n);
    } catch (err) {
      cb(err);
    }
  }

  clear(cb = () => {}) {
    try {
      this.stmts.clear.run();
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}

export default SqliteSessionStore;
