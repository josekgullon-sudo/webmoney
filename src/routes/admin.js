import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import db, { audit, destroySessionsForUser } from '../lib/db.js';
import logger from '../lib/logger.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { formatMoney } from '../lib/money.js';
import { assignPayment, announcePayment, listPayments, recordPayment } from '../services/payments.js';
import { listPayouts, payoutUser, runDailyPayouts } from '../services/payouts.js';
import { ping as krakenPing } from '../services/kraken.js';
import { escapeHtml, notify } from '../services/telegram.js';

export const router = express.Router();
router.use(requireAuth, requireAdmin);

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Contrasena provisional legible que el admin entrega al usuario. */
function generatePassword(length = 14) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function usersWithBalance() {
  return db
    .prepare(
      `SELECT u.*,
              w.asset, w.network, w.address, w.status AS wallet_status, w.kraken_key,
              (SELECT COALESCE(SUM(net_cents), 0) FROM payments p
                WHERE p.user_id = u.id AND p.status = 'succeeded' AND p.payout_id IS NULL) AS pending_cents,
              (SELECT COALESCE(SUM(net_cents), 0) FROM payments p
                WHERE p.user_id = u.id AND p.status = 'succeeded') AS total_cents
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
        ORDER BY u.role DESC, u.username`
    )
    .all();
}

router.get('/admin', (req, res) => {
  res.render('admin/users', {
    title: 'Usuarios',
    users: usersWithBalance(),
    created: req.session.flashCredentials || null,
    error: null,
    formatMoney,
  });
  // Las credenciales recien creadas se muestran una sola vez.
  delete req.session.flashCredentials;
});

router.post('/admin/usuarios', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.display_name || '').trim() || null;
  const feePct = Math.min(Math.max(Number.parseFloat(req.body.fee_pct) || 0, 0), 100);
  const custom = String(req.body.password || '').trim();

  const rerender = (error) =>
    res.status(400).render('admin/users', {
      title: 'Usuarios',
      users: usersWithBalance(),
      created: null,
      error,
      formatMoney,
    });

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return rerender('El usuario debe tener entre 3 y 32 caracteres: letras, numeros, punto, guion o guion bajo.');
  }
  if (custom && custom.length < 10) return rerender('La contrasena debe tener al menos 10 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return rerender('Ese nombre de usuario ya existe.');
  }

  const password = custom || generatePassword();
  const hash = await bcrypt.hash(password, 12);
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, display_name, fee_pct, must_change_password)
       VALUES (?, ?, 'user', ?, ?, 1)`
    )
    .run(username, hash, displayName, feePct);

  audit(req.user.id, 'user.create', { entity: 'user', entityId: info.lastInsertRowid, details: { username }, ip: req.ip });
  req.session.flashCredentials = { username, password };
  req.session.save(() => res.redirect('/admin'));
});

router.post('/admin/usuarios/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.redirect('/admin');

  const password = generatePassword();
  const hash = await bcrypt.hash(password, 12);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?")
    .run(hash, id);
  // Las sesiones abiertas de ese usuario dejan de valer.
  destroySessionsForUser(id);

  audit(req.user.id, 'user.password_reset', { entity: 'user', entityId: id, ip: req.ip });
  req.session.flashCredentials = { username: user.username, password };
  req.session.save(() => res.redirect('/admin'));
});

router.post('/admin/usuarios/:id/estado', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.redirect('/admin');
  if (user.id === req.user.id) return res.redirect('/admin');

  const active = user.active ? 0 : 1;
  db.prepare("UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?").run(active, id);
  if (!active) destroySessionsForUser(id);
  audit(req.user.id, active ? 'user.enable' : 'user.disable', { entity: 'user', entityId: id, ip: req.ip });
  res.redirect('/admin');
});

router.post('/admin/usuarios/:id/comision', (req, res) => {
  const id = Number(req.params.id);
  const feePct = Math.min(Math.max(Number.parseFloat(req.body.fee_pct) || 0, 0), 100);
  db.prepare("UPDATE users SET fee_pct = ?, updated_at = datetime('now') WHERE id = ?").run(feePct, id);
  audit(req.user.id, 'user.fee', { entity: 'user', entityId: id, details: { feePct }, ip: req.ip });
  res.redirect('/admin');
});

router.get('/admin/carteras', (req, res) => {
  res.render('admin/wallets', {
    title: 'Carteras',
    wallets: db
      .prepare(
        `SELECT w.*, u.username, u.display_name
           FROM wallets w JOIN users u ON u.id = w.user_id
          ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END, w.updated_at DESC`
      )
      .all(),
  });
});

router.post('/admin/carteras/:userId/revision', async (req, res) => {
  const userId = Number(req.params.userId);
  const decision = req.body.decision === 'approve' ? 'approved' : 'rejected';
  const krakenKey = String(req.body.kraken_key || '').trim() || null;
  const note = String(req.body.note || '').trim() || null;

  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (!wallet) return res.redirect('/admin/carteras');

  db.prepare(
    `UPDATE wallets SET status = ?, kraken_key = ?, note = ?, reviewed_by = ?, updated_at = datetime('now')
      WHERE user_id = ?`
  ).run(decision, decision === 'approved' ? krakenKey : null, note, req.user.id, userId);

  audit(req.user.id, `wallet.${decision}`, { entity: 'wallet', entityId: userId, details: { krakenKey }, ip: req.ip });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  await notify(
    decision === 'approved'
      ? `✅ Cartera aprobada para <b>${escapeHtml(user.username)}</b>: ${escapeHtml(wallet.asset)} (${escapeHtml(wallet.network)}).`
      : `❌ Cartera rechazada para <b>${escapeHtml(user.username)}</b>${note ? `: ${escapeHtml(note)}` : '.'}`,
    { userChatId: user.telegram_chat_id }
  );

  res.redirect('/admin/carteras');
});

router.post('/admin/cobros/:id/asignar', (req, res) => {
  const paymentId = Number(req.params.id);
  const userId = req.body.user_id ? Number(req.body.user_id) : null;
  const result = assignPayment(paymentId, userId, req.user.id, req.ip);
  if (!result.ok) {
    return res.status(400).render('error', { title: 'No se pudo asignar', message: result.error });
  }
  res.redirect(req.get('referer') || '/panel/cobros');
});

/** Cobro de prueba: sirve para verificar panel + Telegram sin cobrar de verdad. */
router.post('/admin/cobros/prueba', async (req, res) => {
  const cents = Math.max(1, Math.round((Number.parseFloat(req.body.amount) || 10) * 100));
  const userId = req.body.user_id ? Number(req.body.user_id) : null;
  const { payment, user } = recordPayment({
    objectId: `test_${crypto.randomUUID()}`,
    grossCents: cents,
    currency: config.currency,
    description: 'Cobro de prueba creado desde el panel',
    metadata: userId ? { panel_user_id: String(userId) } : {},
  });
  await announcePayment(payment, user);
  audit(req.user.id, 'payment.test', { entity: 'payment', entityId: payment.id, ip: req.ip });
  res.redirect('/panel/cobros');
});

router.get('/admin/pagos', (req, res) => {
  res.render('admin/payouts', {
    title: 'Pagos',
    payouts: listPayouts({ limit: 100 }),
    users: usersWithBalance().filter((u) => u.role === 'user'),
    minPayout: config.payouts.minAmountCents,
    krakenMode: config.kraken.live ? 'live' : 'simulate',
    formatMoney,
  });
});

router.post('/admin/pagos/usuario/:id', async (req, res) => {
  const userId = Number(req.params.id);
  const result = await payoutUser(userId, { actorId: req.user.id, force: true, ip: req.ip });
  if (!result.ok) {
    return res.status(400).render('error', {
      title: 'Pago no realizado',
      message: result.skipped || result.error || 'No se pudo completar el pago.',
      back: '/admin/pagos',
    });
  }
  res.redirect('/admin/pagos');
});

router.post('/admin/pagos/ejecutar', async (req, res) => {
  const results = await runDailyPayouts({ actorId: req.user.id });
  logger.info('pagos lanzados a mano', { total: results.length });
  res.redirect('/admin/pagos');
});

router.get('/admin/estado', async (req, res) => {
  res.render('admin/status', {
    title: 'Estado del sistema',
    checks: {
      stripe: { ok: config.stripe.enabled, webhook: Boolean(config.stripe.webhookSecret) },
      telegram: { ok: config.telegram.enabled, admin: Boolean(config.telegram.adminChatId) },
      kraken: await krakenPing(),
      payouts: config.payouts,
      appUrl: config.appUrl,
      currency: config.currency,
    },
    notifications: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 20').all(),
    events: db.prepare('SELECT * FROM webhook_events ORDER BY id DESC LIMIT 20').all(),
    audits: db
      .prepare(
        `SELECT a.*, u.username FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
          ORDER BY a.id DESC LIMIT 30`
      )
      .all(),
    unassigned: listPayments({ limit: 200 }).filter((p) => !p.user_id).length,
  });
});

router.post('/admin/estado/telegram-test', async (req, res) => {
  await notify('🔔 Prueba de conexion del panel con Telegram. Todo correcto.');
  res.redirect('/admin/estado');
});

export default router;
