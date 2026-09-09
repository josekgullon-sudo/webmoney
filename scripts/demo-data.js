#!/usr/bin/env node
/**
 * Rellena el panel con datos de ejemplo para poder verlo funcionando sin
 * conectar Stripe, Telegram ni Kraken.
 *
 *   npm run demo -- --yes
 *
 * No se debe usar sobre una base de datos con cobros reales: se niega a
 * hacerlo salvo que se le pase --force.
 */
import bcrypt from 'bcryptjs';
import db from '../src/lib/db.js';
import { splitFee } from '../src/lib/money.js';

const flag = (name) => process.argv.includes(`--${name}`);

if (!flag('yes')) {
  console.error('Esto inserta datos falsos en la base de datos.');
  console.error('Si es lo que quieres, repite el comando con --yes');
  process.exit(1);
}

const reales = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE stripe_object_id LIKE 'pi_%'").get().n;
if (reales > 0 && !flag('force')) {
  console.error(`La base de datos ya tiene ${reales} cobro(s) que no son de demostracion.`);
  console.error('Usa otra ruta con DB_PATH, o repite con --force si de verdad quieres mezclarlos.');
  process.exit(1);
}

const CLAVE = 'demo-panel-2026';
const hash = await bcrypt.hash(CLAVE, 12);

const crearUsuario = db.prepare(
  `INSERT INTO users (username, password_hash, role, display_name, fee_pct, must_change_password, last_login_at)
   VALUES (?, ?, ?, ?, ?, 0, datetime('now', ?))
   ON CONFLICT(username) DO UPDATE SET
     password_hash = excluded.password_hash, display_name = excluded.display_name,
     fee_pct = excluded.fee_pct, must_change_password = 0`
);

crearUsuario.run('admin', hash, 'admin', 'Administrador', 0, '-5 minutes');
crearUsuario.run('juan', hash, 'user', 'Juan Perez', 10, '-2 hours');
crearUsuario.run('lucia', hash, 'user', 'Lucia Gomez', 5, '-1 day');
crearUsuario.run('marco', hash, 'user', 'Marco Ruiz', 0, null);

const id = (username) => db.prepare('SELECT id, fee_pct FROM users WHERE username = ?').get(username);
const juan = id('juan');
const lucia = id('lucia');
const marco = id('marco');

// Carteras en los tres estados posibles, para ver como se comporta el panel.
const crearCartera = db.prepare(
  `INSERT INTO wallets (user_id, asset, network, address, kraken_key, status)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     asset = excluded.asset, network = excluded.network, address = excluded.address,
     kraken_key = excluded.kraken_key, status = excluded.status`
);
crearCartera.run(juan.id, 'BTC', 'Bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'juan-btc', 'approved');
crearCartera.run(lucia.id, 'ETH', 'Ethereum', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', null, 'pending');

// Cobros repartidos por los ultimos 14 dias. Semilla fija: siempre el mismo ejemplo.
let semilla = 20260909;
const aleatorio = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);

const CONCEPTOS = [
  'Pedido #1042 · Plan mensual', 'Pedido #1043 · Sesion de asesoria', 'Pedido #1044 · Pack de diseno',
  'Pedido #1045 · Suscripcion anual', 'Pedido #1046 · Mantenimiento web', 'Pedido #1047 · Curso online',
];
const CLIENTES = ['ana@ejemplo.com', 'carlos@ejemplo.com', 'sofia@ejemplo.com', 'diego@ejemplo.com'];

const crearCobro = db.prepare(
  `INSERT INTO payments
     (stripe_object_id, stripe_event_id, user_id, gross_cents, fee_cents, net_cents, currency,
      status, description, customer_email, metadata_json, paid_at, created_at)
   VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`
);

let n = 0;
const insertarTodo = db.transaction(() => {
  db.prepare("DELETE FROM payments WHERE stripe_object_id LIKE 'demo_%'").run();
  db.prepare('DELETE FROM payouts').run();

  for (let dia = 13; dia >= 0; dia -= 1) {
    const cobrosDelDia = 1 + Math.floor(aleatorio() * 4);
    for (let i = 0; i < cobrosDelDia; i += 1) {
      const usuario = [juan, juan, lucia, marco][Math.floor(aleatorio() * 4)];
      const bruto = Math.round((15 + aleatorio() * 285) * 100);
      const { feeCents, netCents } = splitFee(bruto, usuario.fee_pct);
      // Una devolucion suelta para ver el estado en el listado.
      const estado = dia === 6 && i === 0 ? 'refunded' : 'succeeded';
      const desfase = `-${dia} days`;
      crearCobro.run(
        `demo_${dia}_${i}`, `evt_demo_${dia}_${i}`, usuario.id, bruto, feeCents, netCents,
        estado, CONCEPTOS[Math.floor(aleatorio() * CONCEPTOS.length)],
        CLIENTES[Math.floor(aleatorio() * CLIENTES.length)], '{"panel_user":"demo"}', desfase, desfase
      );
      n += 1;
    }
  }

  // Un cobro reciente sin asignar: es lo que el panel pide revisar en Estado.
  crearCobro.run('demo_sin_asignar', 'evt_demo_sin_asignar', null, 4500, 0, 4500,
    'succeeded', 'Pedido #1048 · sin metadata de usuario', 'nuevo@ejemplo.com', '{}', '-3 hours', '-3 hours');
  n += 1;

  // Dos envios ya realizados a la cartera de Juan (en modo simulacion).
  const crearPago = db.prepare(
    `INSERT INTO payouts (user_id, period_date, amount_cents, currency, asset, network, address,
                          kraken_key, quote_price, volume, kraken_order_txid, kraken_refid, status,
                          simulated, created_at, updated_at)
     VALUES (?, date('now', ?), ?, 'EUR', 'BTC', 'Bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
             'juan-btc', ?, ?, ?, ?, 'sent', 1, datetime('now', ?), datetime('now', ?))
     RETURNING id`
  );
  for (const [dias, precio] of [[-3, 58420.5], [-2, 59110.0]]) {
    const importe = db.prepare(
      `SELECT COALESCE(SUM(net_cents), 0) AS c FROM payments
        WHERE user_id = ? AND status = 'succeeded' AND payout_id IS NULL
          AND date(paid_at, 'localtime') = date('now', 'localtime', ?)`
    ).get(juan.id, `${dias} days`).c;
    if (importe <= 0) continue;

    const volumen = Math.floor((importe / 100 / precio) * 1e8) / 1e8;
    const pago = crearPago.get(
      juan.id, `${dias} days`, importe, precio, volumen,
      `O${dias}DEMO-TXID`, `SIM-WD-${10 + dias}`, `${dias} days`, `${dias} days`
    );
    db.prepare(
      `UPDATE payments SET payout_id = ?
        WHERE user_id = ? AND status = 'succeeded' AND payout_id IS NULL
          AND date(paid_at, 'localtime') = date('now', 'localtime', ?)`
    ).run(pago.id, juan.id, `${dias} days`);
  }
});

insertarTodo();

console.log(`Datos de demostracion creados: ${n} cobros, 4 usuarios, 2 carteras, 2 pagos enviados.`);
console.log('');
console.log('  Administrador:  admin  /  ' + CLAVE);
console.log('  Usuario:        juan   /  ' + CLAVE);
console.log('');
console.log('Arranca el panel con: npm start');
db.close();
