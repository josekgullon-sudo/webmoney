import express from 'express';
import config from '../config.js';
import db, { audit } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { ASSETS, ASSET_CODES, validateWallet } from '../lib/assets.js';
import { formatMoney } from '../lib/money.js';
import { dailySeries, listPayments, pendingBalance, userStats } from '../services/payments.js';
import { listPayouts } from '../services/payouts.js';
import { escapeHtml, notify } from '../services/telegram.js';

export const router = express.Router();
router.use(requireAuth);

/** El admin ve el total de la plataforma; cada usuario solo lo suyo. */
function scopeId(user) {
  return user.role === 'admin' ? null : user.id;
}

router.get('/panel', (req, res) => {
  const scope = scopeId(req.user);
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  res.render('dashboard', {
    title: 'Panel',
    stats: userStats(scope),
    pending: scope === null
      ? db.prepare(
          `SELECT COALESCE(SUM(net_cents),0) AS cents, COUNT(*) AS count
             FROM payments WHERE status = 'succeeded' AND payout_id IS NULL`
        ).get()
      : pendingBalance(req.user.id),
    payments: listPayments({ userId: scope, limit: 15 }),
    payouts: listPayouts({ userId: scope, limit: 5 }),
    series: dailySeries(scope, 14),
    wallet,
    currency: config.currency,
    minPayout: config.payouts.minAmountCents,
    formatMoney,
  });
});

router.get('/panel/cobros', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const perPage = 50;
  const scope = scopeId(req.user);
  res.render('payments', {
    title: 'Cobros',
    payments: listPayments({ userId: scope, limit: perPage, offset: (page - 1) * perPage }),
    page,
    perPage,
    isAdmin: req.user.role === 'admin',
    users: req.user.role === 'admin'
      ? db.prepare("SELECT id, username, display_name FROM users WHERE role = 'user' ORDER BY username").all()
      : [],
    formatMoney,
  });
});

router.get('/panel/pagos', (req, res) => {
  res.render('payouts', {
    title: 'Pagos a mi cartera',
    payouts: listPayouts({ userId: scopeId(req.user), limit: 100 }),
    isAdmin: req.user.role === 'admin',
    formatMoney,
  });
});

router.get('/panel/cartera', (req, res) => {
  res.render('wallet', {
    title: 'Mi cartera',
    wallet: db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id),
    assets: ASSETS,
    assetCodes: ASSET_CODES,
    error: null,
    ok: req.query.ok === '1',
  });
});

router.post('/panel/cartera', async (req, res) => {
  const current = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  const result = validateWallet({
    asset: req.body.asset,
    network: req.body.network,
    address: req.body.address,
  });

  if (!result.ok) {
    return res.status(400).render('wallet', {
      title: 'Mi cartera',
      wallet: { ...current, ...req.body },
      assets: ASSETS,
      assetCodes: ASSET_CODES,
      error: result.error,
      ok: false,
    });
  }

  const unchanged =
    current &&
    current.asset === result.asset &&
    current.network === result.network &&
    current.address === result.address;

  if (unchanged) return res.redirect('/panel/cartera?ok=1');

  const memo = String(req.body.memo || '').trim() || null;
  // Toda cartera nueva o modificada vuelve a "pendiente": el admin la revisa y la
  // da de alta en la lista blanca de Kraken antes de que reciba dinero.
  db.prepare(
    `INSERT INTO wallets (user_id, asset, network, address, memo, status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(user_id) DO UPDATE SET
       asset = excluded.asset, network = excluded.network, address = excluded.address,
       memo = excluded.memo, status = 'pending', kraken_key = NULL, reviewed_by = NULL,
       updated_at = datetime('now')`
  ).run(req.user.id, result.asset, result.network, result.address, memo);

  audit(req.user.id, 'wallet.update', {
    entity: 'wallet',
    entityId: req.user.id,
    details: { asset: result.asset, network: result.network, address: result.address },
    ip: req.ip,
  });

  await notify(
    [
      '🔐 <b>Cartera pendiente de aprobar</b>',
      `Usuario: ${escapeHtml(req.user.display_name || req.user.username)}`,
      `${escapeHtml(result.asset)} (${escapeHtml(result.network)})`,
      `<code>${escapeHtml(result.address)}</code>`,
      `<a href="${config.appUrl}/admin/carteras">Revisar en el panel</a>`,
    ].join('\n')
  );

  res.redirect('/panel/cartera?ok=1');
});

router.get('/panel/perfil', (req, res) => {
  res.render('profile', { title: 'Mi perfil', ok: req.query.ok === '1', error: null });
});

router.post('/panel/perfil', (req, res) => {
  const chatId = String(req.body.telegram_chat_id || '').trim();
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
    return res.status(400).render('profile', {
      title: 'Mi perfil',
      ok: false,
      error: 'El chat ID de Telegram debe ser un numero (escribe /start a tu bot para obtenerlo).',
    });
  }
  db.prepare("UPDATE users SET telegram_chat_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(chatId || null, req.user.id);
  audit(req.user.id, 'profile.update', { entity: 'user', entityId: req.user.id, ip: req.ip });
  res.redirect('/panel/perfil?ok=1');
});

router.post('/panel/perfil/telegram-test', async (req, res) => {
  const user = db.prepare('SELECT telegram_chat_id FROM users WHERE id = ?').get(req.user.id);
  if (user.telegram_chat_id) {
    await notify(`🔔 Prueba de aviso para ${escapeHtml(req.user.username)}. Si lees esto, funciona.`, {
      userChatId: user.telegram_chat_id,
    });
  }
  res.redirect('/panel/perfil?ok=1');
});

export default router;
