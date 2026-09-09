import config from '../config.js';
import db, { audit } from '../lib/db.js';
import logger from '../lib/logger.js';
import { formatMoney, toMajor } from '../lib/money.js';
import { publish } from '../lib/events.js';
import { getAsset } from '../lib/assets.js';
import { escapeHtml, notify } from './telegram.js';
import * as kraken from './kraken.js';

function floorTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

/** Usuarios con saldo pendiente y cartera aprobada. */
export function eligibleUsers({ minCents = config.payouts.minAmountCents } = {}) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.telegram_chat_id,
              w.asset, w.network, w.address, w.kraken_key,
              COALESCE(SUM(p.net_cents), 0) AS pending_cents
         FROM users u
         JOIN wallets w  ON w.user_id = u.id AND w.status = 'approved'
         JOIN payments p ON p.user_id = u.id AND p.status = 'succeeded' AND p.payout_id IS NULL
        WHERE u.active = 1 AND u.role = 'user'
        GROUP BY u.id
       HAVING pending_cents >= ?`
    )
    .all(minCents);
}

/**
 * Reserva el saldo pendiente del usuario creando un pago y marcando sus cobros.
 * Se hace en una transaccion para que dos ejecuciones simultaneas no puedan
 * enviar el mismo dinero dos veces.
 */
const reserve = db.transaction((user, wallet, currency) => {
  const { cents } = db
    .prepare(
      `SELECT COALESCE(SUM(net_cents), 0) AS cents
         FROM payments
        WHERE user_id = ? AND status = 'succeeded' AND payout_id IS NULL`
    )
    .get(user.id);
  if (cents <= 0) return null;

  const info = db
    .prepare(
      `INSERT INTO payouts (user_id, period_date, amount_cents, currency, asset, network, address, kraken_key, status)
       VALUES (?, date('now','localtime'), ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(user.id, cents, currency, wallet.asset, wallet.network, wallet.address, wallet.kraken_key);

  db.prepare(
    `UPDATE payments SET payout_id = ?
      WHERE user_id = ? AND status = 'succeeded' AND payout_id IS NULL`
  ).run(info.lastInsertRowid, user.id);

  return db.prepare('SELECT * FROM payouts WHERE id = ?').get(info.lastInsertRowid);
});

/** Devuelve el saldo a "pendiente" para que se reintente en la siguiente ejecucion. */
function releasePayments(payoutId) {
  db.prepare('UPDATE payments SET payout_id = NULL WHERE payout_id = ?').run(payoutId);
}

function setStatus(payoutId, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE payouts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), payoutId);
}

/**
 * Convierte el saldo del usuario a su cripto y lo envia a su cartera.
 * En modo `simulate` recorre el mismo camino pero sin mover dinero real.
 * `deps` permite sustituir las llamadas a Kraken en los tests.
 */
export async function executePayout(payout, deps = {}) {
  const { getPrice, marketBuy, withdraw } = { ...kraken, ...deps };
  const spec = getAsset(payout.asset);
  if (!spec) throw new Error(`Criptomoneda no admitida: ${payout.asset}`);

  const amount = toMajor(payout.amount_cents, payout.currency);
  const simulated = !config.kraken.live;

  const price = await getPrice(spec.pair);
  const volume = floorTo(amount / price, spec.decimals);
  if (volume <= 0) throw new Error('El importe es demasiado pequeno para convertirlo.');

  setStatus(payout.id, { status: 'trading', quote_price: price, volume, simulated: simulated ? 1 : 0 });

  let orderTxid = null;
  if (config.kraken.tradeBeforeWithdraw) {
    orderTxid = simulated
      ? `SIM-ORDER-${payout.id}`
      : (await marketBuy(spec.pair, volume)).txid;
  }

  setStatus(payout.id, { status: 'withdrawing', kraken_order_txid: orderTxid });

  if (!simulated && !payout.kraken_key) {
    throw new Error(
      'La cartera no tiene asignado el nombre de retirada de Kraken. Da de alta la direccion en Kraken (Funding > Withdraw) y guarda ese nombre en el panel.'
    );
  }

  const refid = simulated
    ? `SIM-WD-${payout.id}`
    : (await withdraw({ asset: spec.krakenAsset, key: payout.kraken_key, amount: volume })).refid;

  setStatus(payout.id, { status: 'sent', kraken_refid: refid });
  return { ...payout, status: 'sent', volume, quote_price: price, kraken_refid: refid, simulated };
}

/**
 * Paga a un usuario el saldo acumulado.
 * @returns {Promise<{ok: boolean, skipped?: string, payout?: object, error?: string}>}
 */
export async function payoutUser(userId, { actorId = null, force = false, ip = null, deps = {} } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
  if (!user) return { ok: false, skipped: 'usuario inactivo o inexistente' };

  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (!wallet || wallet.status !== 'approved') {
    return { ok: false, skipped: 'el usuario no tiene una cartera aprobada' };
  }

  const { cents } = db
    .prepare(
      `SELECT COALESCE(SUM(net_cents), 0) AS cents
         FROM payments WHERE user_id = ? AND status = 'succeeded' AND payout_id IS NULL`
    )
    .get(userId);
  if (cents <= 0) return { ok: false, skipped: 'sin saldo pendiente' };
  if (!force && cents < config.payouts.minAmountCents) {
    return { ok: false, skipped: `saldo por debajo del minimo (${formatMoney(config.payouts.minAmountCents, config.currency)})` };
  }

  const payout = reserve(user, wallet, config.currency);
  if (!payout) return { ok: false, skipped: 'sin saldo pendiente' };

  audit(actorId, 'payout.start', { entity: 'payout', entityId: payout.id, details: { userId, cents }, ip });

  try {
    const done = await executePayout(payout, deps);
    logger.info('pago enviado', { payoutId: payout.id, userId, refid: done.kraken_refid });
    publish({ type: 'payout', userId, data: { id: payout.id, status: 'sent' } });

    await notify(
      [
        done.simulated ? '🧪 <b>Pago simulado</b> (KRAKEN_MODE=simulate)' : '✅ <b>Pago enviado</b>',
        `Usuario: ${escapeHtml(user.display_name || user.username)}`,
        `Importe: <b>${escapeHtml(formatMoney(payout.amount_cents, payout.currency))}</b>`,
        `Cripto: ${escapeHtml(`${done.volume} ${payout.asset}`)} (${escapeHtml(payout.network || '')})`,
        `Cartera: <code>${escapeHtml(payout.address)}</code>`,
        done.kraken_refid ? `Ref. Kraken: <code>${escapeHtml(done.kraken_refid)}</code>` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      { userChatId: user.telegram_chat_id }
    );

    return { ok: true, payout: done };
  } catch (err) {
    logger.error('pago fallido', { payoutId: payout.id, userId, error: err.message });
    setStatus(payout.id, { status: 'failed', error: err.message });
    // El saldo vuelve a quedar pendiente para reintentarlo sin perder cobros.
    releasePayments(payout.id);
    publish({ type: 'payout', userId, data: { id: payout.id, status: 'failed' } });

    await notify(
      [
        '⚠️ <b>Pago fallido</b>',
        `Usuario: ${escapeHtml(user.display_name || user.username)}`,
        `Importe: ${escapeHtml(formatMoney(payout.amount_cents, payout.currency))}`,
        `Motivo: ${escapeHtml(err.message)}`,
        'El saldo sigue pendiente y se reintentara.',
      ].join('\n')
    );

    return { ok: false, error: err.message, payout };
  }
}

/** Ejecucion diaria: paga a todos los usuarios que cumplen las condiciones. */
export async function runDailyPayouts({ actorId = null } = {}) {
  const users = eligibleUsers();
  logger.info('inicio de pagos diarios', { candidatos: users.length });
  const results = [];
  for (const user of users) {
    results.push({ user: user.username, ...(await payoutUser(user.id, { actorId })) });
  }

  const sent = results.filter((r) => r.ok);
  if (sent.length > 0 || results.length > 0) {
    const total = sent.reduce((acc, r) => acc + (r.payout?.amount_cents || 0), 0);
    await notify(
      [
        '📊 <b>Resumen de pagos del dia</b>',
        `Enviados: ${sent.length}/${results.length}`,
        `Total: <b>${escapeHtml(formatMoney(total, config.currency))}</b>`,
      ].join('\n')
    );
  }
  return results;
}

export function listPayouts({ userId = null, limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT po.*, u.username, u.display_name
         FROM payouts po
         JOIN users u ON u.id = po.user_id
        WHERE (? IS NULL OR po.user_id = ?)
        ORDER BY po.created_at DESC, po.id DESC
        LIMIT ?`
    )
    .all(userId ?? null, userId ?? null, limit);
}
