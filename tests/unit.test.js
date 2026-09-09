import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Base de datos temporal: los tests no tocan los datos reales.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-')), 'test.db');
process.env.NODE_ENV = 'test';
// Entorno fijo para que los tests no dependan de la configuracion de la maquina.
// Las llamadas a Kraken se sustituyen por dobles, asi que no se toca la red.
process.env.KRAKEN_MODE = 'live';
process.env.KRAKEN_API_KEY = 'clave-de-prueba';
process.env.KRAKEN_API_SECRET = 'c2VjcmV0by1kZS1wcnVlYmE=';
process.env.PAYOUT_MIN_AMOUNT = '100';

const { splitFee, formatMoney } = await import('../src/lib/money.js');
const { validateWallet } = await import('../src/lib/assets.js');
const { signRequest } = await import('../src/services/kraken.js');
const db = (await import('../src/lib/db.js')).default;
const { recordPayment, pendingBalance, resolveUser } = await import('../src/services/payments.js');
const config = (await import('../src/config.js')).default;

test('splitFee reparte la comision sin perder centimos', () => {
  assert.deepEqual(splitFee(10000, 10), { feeCents: 1000, netCents: 9000 });
  assert.deepEqual(splitFee(999, 15), { feeCents: 149, netCents: 850 });
  assert.deepEqual(splitFee(500, 0), { feeCents: 0, netCents: 500 });
  // El redondeo siempre favorece al usuario y nunca supera el bruto.
  for (const gross of [1, 7, 33, 12345]) {
    const { feeCents, netCents } = splitFee(gross, 33.3);
    assert.equal(feeCents + netCents, gross);
    assert.ok(netCents >= 0 && feeCents >= 0);
  }
});

test('splitFee acota porcentajes invalidos', () => {
  assert.deepEqual(splitFee(1000, -5), { feeCents: 0, netCents: 1000 });
  assert.deepEqual(splitFee(1000, 150), { feeCents: 1000, netCents: 0 });
  assert.deepEqual(splitFee(1000, NaN), { feeCents: 0, netCents: 1000 });
});

test('formatMoney muestra decimales y moneda', () => {
  // El separador de miles depende de los datos ICU del sistema, asi que no se fija aqui.
  const text = formatMoney(123456, 'EUR');
  assert.match(text, /1\.?234,56/);
  assert.match(text, /€|EUR/);
  assert.equal(formatMoney(0, 'EUR').includes('0,00'), true);
});

test('validateWallet acepta direcciones bien formadas y rechaza el resto', () => {
  assert.equal(validateWallet({ asset: 'BTC', network: 'Bitcoin', address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }).ok, true);
  assert.equal(validateWallet({ asset: 'ETH', network: 'Ethereum', address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e' }).ok, true);
  assert.equal(validateWallet({ asset: 'BTC', network: 'Ethereum', address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }).ok, false);
  assert.equal(validateWallet({ asset: 'DOGE', network: 'Dogecoin', address: 'x' }).ok, false);
  assert.equal(validateWallet({ asset: 'ETH', network: 'Ethereum', address: '0x123' }).ok, false);
});

test('la firma de Kraken coincide con el ejemplo oficial de su documentacion', () => {
  const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
  const postData = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
  assert.equal(
    signRequest('/0/private/AddOrder', postData, '1616492376594', secret),
    '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ=='
  );
});

test('un cobro repetido de Stripe no duplica ingresos', () => {
  db.prepare(
    "INSERT INTO users (username, password_hash, role, display_name, fee_pct) VALUES ('juan', 'x', 'user', 'Juan', 10)"
  ).run();
  const user = db.prepare("SELECT * FROM users WHERE username = 'juan'").get();

  const first = recordPayment({
    objectId: 'pi_test_1',
    grossCents: 10000,
    currency: 'EUR',
    metadata: { panel_user: 'juan' },
  });
  assert.equal(first.created, true);
  assert.equal(first.payment.user_id, user.id);
  assert.equal(first.payment.fee_cents, 1000);
  assert.equal(first.payment.net_cents, 9000);

  const second = recordPayment({ objectId: 'pi_test_1', grossCents: 10000, currency: 'EUR' });
  assert.equal(second.created, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 1);
  assert.equal(pendingBalance(user.id).cents, 9000);
});

test('resolveUser encuentra al usuario por id y por nombre', () => {
  const user = db.prepare("SELECT * FROM users WHERE username = 'juan'").get();
  assert.equal(resolveUser({ panel_user_id: String(user.id) })?.id, user.id);
  assert.equal(resolveUser({ panel_user: 'juan' })?.id, user.id);
  assert.equal(resolveUser({ panel_user: 'no-existe' })?.id, user.id, 'cae en el unico usuario activo');
});

test('un pago correcto convierte el saldo, lo retira y deja el pendiente a cero', async () => {
  const user = db.prepare("SELECT * FROM users WHERE username = 'juan'").get();
  db.prepare(
    `INSERT INTO wallets (user_id, asset, network, address, kraken_key, status)
     VALUES (?, 'BTC', 'Bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'juan-btc', 'approved')`
  ).run(user.id);

  const { payoutUser } = await import('../src/services/payouts.js');
  const llamadas = [];
  const result = await payoutUser(user.id, {
    force: true,
    deps: {
      getPrice: async (pair) => { llamadas.push(['getPrice', pair]); return 50000; },
      marketBuy: async (pair, volume) => { llamadas.push(['marketBuy', pair, volume]); return { txid: 'OABC-1' }; },
      withdraw: async (args) => { llamadas.push(['withdraw', args]); return { refid: 'REF-1' }; },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(llamadas[0][1], 'XBTEUR');
  // 90,00 EUR a 50.000 EUR/BTC = 0,0018 BTC, truncado a 8 decimales.
  assert.equal(llamadas[1][2], 0.0018);
  assert.deepEqual(llamadas[2][1], { asset: 'XBT', key: 'juan-btc', amount: 0.0018 });

  const payout = db.prepare('SELECT * FROM payouts ORDER BY id DESC LIMIT 1').get();
  assert.equal(payout.status, 'sent');
  assert.equal(payout.simulated, 0);
  assert.equal(payout.amount_cents, 9000);
  assert.equal(payout.kraken_refid, 'REF-1');
  assert.equal(payout.kraken_order_txid, 'OABC-1');
  // El saldo queda a cero y los cobros pagados apuntan a este envio.
  assert.equal(pendingBalance(user.id).cents, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE payout_id = ?').get(payout.id).n, 1);
});

test('en modo simulacion no se envia ninguna orden real', async () => {
  const user = db.prepare("SELECT * FROM users WHERE username = 'juan'").get();
  recordPayment({ objectId: 'pi_sim_1', grossCents: 20000, currency: 'EUR', metadata: { panel_user: 'juan' } });

  const { payoutUser } = await import('../src/services/payouts.js');
  const original = config.kraken.mode;
  config.kraken.mode = 'simulate';
  const llamadas = [];
  const result = await payoutUser(user.id, {
    force: true,
    deps: {
      getPrice: async () => 50000,
      marketBuy: async () => { llamadas.push('marketBuy'); return { txid: 'NO' }; },
      withdraw: async () => { llamadas.push('withdraw'); return { refid: 'NO' }; },
    },
  });
  config.kraken.mode = original;

  assert.equal(result.ok, true);
  assert.deepEqual(llamadas, [], 'ni compra ni retirada tocan Kraken en simulacion');
  const payout = db.prepare('SELECT * FROM payouts ORDER BY id DESC LIMIT 1').get();
  assert.equal(payout.simulated, 1);
  assert.match(payout.kraken_refid, /^SIM-WD-/);
  assert.equal(pendingBalance(user.id).cents, 0);
});

test('si Kraken falla, el dinero vuelve a quedar pendiente', async () => {
  const user = db.prepare("SELECT * FROM users WHERE username = 'juan'").get();
  recordPayment({ objectId: 'pi_test_2', grossCents: 5000, currency: 'EUR', metadata: { panel_user: 'juan' } });
  assert.equal(pendingBalance(user.id).cents, 4500);

  const { payoutUser } = await import('../src/services/payouts.js');
  const result = await payoutUser(user.id, {
    force: true,
    deps: { getPrice: async () => { throw new Error('Kraken no responde'); } },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Kraken no responde/);
  const payout = db.prepare('SELECT * FROM payouts ORDER BY id DESC LIMIT 1').get();
  assert.equal(payout.status, 'failed');
  // Lo importante: el cobro no se pierde y se reintentara en la siguiente tanda.
  assert.equal(pendingBalance(user.id).cents, 4500);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE payout_id = ?').get(payout.id).n, 0);
});

test('no se paga por debajo del minimo ni sin cartera aprobada', async () => {
  const { payoutUser } = await import('../src/services/payouts.js');
  const user = db.prepare("SELECT * FROM users WHERE username = 'juan'").get();

  const bajoMinimo = await payoutUser(user.id, {});
  assert.equal(bajoMinimo.ok, false);
  assert.match(bajoMinimo.skipped, /minimo/);

  db.prepare("UPDATE wallets SET status = 'pending' WHERE user_id = ?").run(user.id);
  const sinCartera = await payoutUser(user.id, { force: true });
  assert.equal(sinCartera.ok, false);
  assert.match(sinCartera.skipped, /cartera/);
});
