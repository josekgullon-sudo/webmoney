import config from '../config.js';
import db, { audit } from '../lib/db.js';
import logger from '../lib/logger.js';
import { formatMoney, splitFee } from '../lib/money.js';
import { publish } from '../lib/events.js';
import { escapeHtml, notify } from './telegram.js';

/**
 * Decide a que usuario del panel pertenece un cobro de Stripe.
 * Orden: metadata.panel_user_id -> metadata.panel_user (username) -> unico usuario
 * no admin activo -> sin asignar (el admin lo asigna a mano desde el panel).
 */
export function resolveUser(metadata = {}) {
  const byId = metadata.panel_user_id ?? metadata.user_id;
  if (byId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(Number(byId));
    if (user) return user;
  }
  const byName = metadata.panel_user ?? metadata.username;
  if (byName) {
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(byName));
    if (user) return user;
  }
  const candidates = db.prepare("SELECT * FROM users WHERE role = 'user' AND active = 1 LIMIT 2").all();
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Guarda un cobro. Es idempotente por `stripe_object_id`, asi que Stripe puede
 * reenviar el mismo evento sin duplicar ingresos.
 * @returns {{created: boolean, payment: object|null}}
 */
export function recordPayment({
  objectId,
  eventId = null,
  grossCents,
  currency,
  description = null,
  customerEmail = null,
  metadata = {},
  paidAt = null,
}) {
  const existing = db.prepare('SELECT * FROM payments WHERE stripe_object_id = ?').get(objectId);
  if (existing) return { created: false, payment: existing };

  const user = resolveUser(metadata);
  const feePct = user ? user.fee_pct : config.defaultFeePct;
  const { feeCents, netCents } = splitFee(grossCents, feePct);

  const info = db
    .prepare(
      `INSERT INTO payments
         (stripe_object_id, stripe_event_id, user_id, gross_cents, fee_cents, net_cents,
          currency, status, description, customer_email, metadata_json, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, COALESCE(?, datetime('now')))`
    )
    .run(
      objectId,
      eventId,
      user?.id ?? null,
      grossCents,
      feeCents,
      netCents,
      currency.toUpperCase(),
      description,
      customerEmail,
      JSON.stringify(metadata ?? {}),
      paidAt
    );

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid);
  logger.info('cobro registrado', { id: payment.id, objectId, userId: user?.id ?? null });
  return { created: true, payment, user };
}

/** Marca un cobro como devuelto/disputado para que no entre en el pago diario. */
export function markPaymentStatus(objectId, status) {
  const payment = db.prepare('SELECT * FROM payments WHERE stripe_object_id = ?').get(objectId);
  if (!payment) return null;
  db.prepare("UPDATE payments SET status = ? WHERE id = ?").run(status, payment.id);
  return { ...payment, status };
}

/** Avisa por Telegram y empuja el cobro al panel abierto en el navegador. */
export async function announcePayment(payment, user) {
  publish({ type: 'payment', userId: payment.user_id, data: { id: payment.id } });

  const lines = [
    '💶 <b>Nuevo cobro recibido</b>',
    `Importe: <b>${escapeHtml(formatMoney(payment.gross_cents, payment.currency))}</b>`,
  ];
  if (payment.fee_cents > 0) {
    lines.push(`Neto para el usuario: ${escapeHtml(formatMoney(payment.net_cents, payment.currency))}`);
  }
  lines.push(`Usuario: ${escapeHtml(user?.display_name || user?.username || 'sin asignar')}`);
  if (payment.description) lines.push(`Concepto: ${escapeHtml(payment.description)}`);
  if (payment.customer_email) lines.push(`Cliente: ${escapeHtml(payment.customer_email)}`);
  lines.push(`<a href="${config.appUrl}/panel">Abrir panel</a>`);

  await notify(lines.join('\n'), { userChatId: user?.telegram_chat_id });
}

/** Saldo del dia aun no enviado a la cartera del usuario. */
export function pendingBalance(userId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(net_cents), 0) AS cents, COUNT(*) AS n
         FROM payments
        WHERE user_id = ? AND status = 'succeeded' AND payout_id IS NULL`
    )
    .get(userId);
  return { cents: row.cents, count: row.n };
}

export function userStats(userId) {
  const stats = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN date(paid_at,'localtime') = date('now','localtime') THEN gross_cents END), 0) AS today_gross,
         COALESCE(SUM(CASE WHEN date(paid_at,'localtime') = date('now','localtime') THEN net_cents   END), 0) AS today_net,
         COALESCE(SUM(CASE WHEN date(paid_at,'localtime') = date('now','localtime') THEN 1           END), 0) AS today_count,
         COALESCE(SUM(CASE WHEN strftime('%Y-%m', paid_at, 'localtime') = strftime('%Y-%m','now','localtime') THEN net_cents END), 0) AS month_net,
         COALESCE(SUM(net_cents), 0) AS total_net,
         COUNT(*) AS total_count
       FROM payments
      WHERE status = 'succeeded' AND (? IS NULL OR user_id = ?)`
    )
    .get(userId ?? null, userId ?? null);
  return stats;
}

export function listPayments({ userId = null, limit = 50, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT p.*, u.username, u.display_name
         FROM payments p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE (? IS NULL OR p.user_id = ?)
        ORDER BY p.paid_at DESC, p.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(userId ?? null, userId ?? null, limit, offset);
}

export function dailySeries(userId, days = 14) {
  return db
    .prepare(
      `SELECT date(paid_at, 'localtime') AS day,
              COALESCE(SUM(net_cents), 0) AS net_cents,
              COUNT(*) AS n
         FROM payments
        WHERE status = 'succeeded'
          AND (? IS NULL OR user_id = ?)
          AND date(paid_at, 'localtime') >= date('now', 'localtime', ?)
        GROUP BY day
        ORDER BY day DESC`
    )
    .all(userId ?? null, userId ?? null, `-${Math.max(1, days) - 1} days`);
}

export function assignPayment(paymentId, userId, actorId, ip) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) return { ok: false, error: 'Cobro no encontrado.' };
  if (payment.payout_id) return { ok: false, error: 'Ese cobro ya se ha pagado; no se puede reasignar.' };

  const user = userId ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : null;
  if (userId && !user) return { ok: false, error: 'Usuario no encontrado.' };

  const feePct = user ? user.fee_pct : config.defaultFeePct;
  const { feeCents, netCents } = splitFee(payment.gross_cents, feePct);
  db.prepare('UPDATE payments SET user_id = ?, fee_cents = ?, net_cents = ? WHERE id = ?')
    .run(user?.id ?? null, feeCents, netCents, paymentId);

  audit(actorId, 'payment.assign', { entity: 'payment', entityId: paymentId, details: { userId: user?.id ?? null }, ip });
  publish({ type: 'payment', userId: user?.id ?? null, data: { id: paymentId } });
  return { ok: true };
}
