#!/usr/bin/env node
// Lanza la tanda de pagos diarios a mano (util para cron externo o para probar).
import { runDailyPayouts } from '../src/services/payouts.js';
import db from '../src/lib/db.js';

const results = await runDailyPayouts();
if (results.length === 0) {
  console.log('No hay usuarios con saldo suficiente y cartera aprobada.');
}
for (const r of results) {
  console.log(`${r.user}: ${r.ok ? 'enviado' : `omitido (${r.skipped || r.error})`}`);
}
db.close();
