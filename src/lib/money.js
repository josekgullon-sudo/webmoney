// Todo el dinero fiat se guarda en enteros (centimos) para no perder precision.

const ZERO_DECIMAL = new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);

export function minorUnitFactor(currency) {
  return ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 1 : 100;
}

export function toMajor(cents, currency = 'EUR') {
  return cents / minorUnitFactor(currency);
}

export function formatMoney(cents, currency = 'EUR') {
  const value = toMajor(cents ?? 0, currency);
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Comision de la plataforma. Redondea al centimo hacia abajo a favor del usuario. */
export function splitFee(grossCents, feePct) {
  const pct = Number.isFinite(feePct) ? Math.min(Math.max(feePct, 0), 100) : 0;
  const fee = Math.floor((grossCents * pct) / 100);
  return { feeCents: fee, netCents: grossCents - fee };
}
