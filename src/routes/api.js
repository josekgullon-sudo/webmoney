import express from 'express';
import config from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import panelEvents from '../lib/events.js';
import { formatMoney } from '../lib/money.js';
import { etiqueta } from '../lib/labels.js';
import { listPayments, pendingBalance, userStats } from '../services/payments.js';
import db from '../lib/db.js';

export const router = express.Router();

function scopeId(user) {
  return user.role === 'admin' ? null : user.id;
}

/** Flujo SSE: el panel se actualiza solo cuando entra un cobro o sale un pago. */
router.get('/api/stream', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');

  const scope = scopeId(req.user);
  const onEvent = (event) => {
    // Un usuario normal solo recibe lo suyo; el admin lo ve todo.
    if (scope !== null && event.userId !== scope) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  panelEvents.on('panel', onEvent);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    panelEvents.off('panel', onEvent);
  });
});

router.get('/api/resumen', requireAuth, (req, res) => {
  const scope = scopeId(req.user);
  const pending =
    scope === null
      ? db.prepare(
          `SELECT COALESCE(SUM(net_cents),0) AS cents, COUNT(*) AS count
             FROM payments WHERE status = 'succeeded' AND payout_id IS NULL`
        ).get()
      : pendingBalance(req.user.id);
  const stats = userStats(scope);

  res.json({
    currency: config.currency,
    pending: { cents: pending.cents, text: formatMoney(pending.cents, config.currency), count: pending.count },
    today: {
      gross: formatMoney(stats.today_gross, config.currency),
      net: formatMoney(stats.today_net, config.currency),
      count: stats.today_count,
    },
    month: { net: formatMoney(stats.month_net, config.currency) },
    payments: listPayments({ userId: scope, limit: 15 }).map((p) => ({
      id: p.id,
      amount: formatMoney(p.gross_cents, p.currency),
      net: formatMoney(p.net_cents, p.currency),
      status: p.status,
      statusText: etiqueta(p.status),
      description: p.description,
      user: p.display_name || p.username || null,
      paidAt: p.paid_at,
    })),
  });
});

router.get('/api/salud', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

export default router;
