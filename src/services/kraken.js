import crypto from 'node:crypto';
import config from '../config.js';
import logger from '../lib/logger.js';

const BASE = 'https://api.kraken.com';

let lastNonce = 0;
function nextNonce() {
  const now = Date.now() * 1000;
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  return String(lastNonce);
}

export class KrakenError extends Error {
  constructor(message, { method, kraken } = {}) {
    super(message);
    this.name = 'KrakenError';
    this.method = method;
    this.kraken = kraken;
  }
}

/** Firma del API privado de Kraken: HMAC-SHA512(path + SHA256(nonce + postdata), secret). */
export function signRequest(urlPath, postData, nonce, apiSecret) {
  const sha256 = crypto.createHash('sha256').update(nonce + postData).digest();
  return crypto
    .createHmac('sha512', Buffer.from(apiSecret, 'base64'))
    .update(Buffer.concat([Buffer.from(urlPath, 'utf8'), sha256]))
    .digest('base64');
}

async function publicCall(method, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `${BASE}/0/public/${method}${query ? `?${query}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (body?.error?.length) throw new KrakenError(body.error.join('; '), { method, kraken: body.error });
  if (!res.ok) throw new KrakenError(`HTTP ${res.status}`, { method });
  return body.result;
}

async function privateCall(method, params = {}) {
  if (!config.kraken.apiKey || !config.kraken.apiSecret) {
    throw new KrakenError('Faltan KRAKEN_API_KEY / KRAKEN_API_SECRET', { method });
  }
  const urlPath = `/0/private/${method}`;
  const nonce = nextNonce();
  const postData = new URLSearchParams({ nonce, ...params }).toString();
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: {
      'API-Key': config.kraken.apiKey,
      'API-Sign': signRequest(urlPath, postData, nonce, config.kraken.apiSecret),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'webmoney-panel/1.0',
    },
    body: postData,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (body?.error?.length) throw new KrakenError(body.error.join('; '), { method, kraken: body.error });
  if (!res.ok) throw new KrakenError(`HTTP ${res.status}`, { method });
  return body.result;
}

/** Precio de mercado actual del par (ultimo cruce). */
export async function getPrice(pair) {
  const result = await publicCall('Ticker', { pair });
  const first = Object.values(result || {})[0];
  const price = Number.parseFloat(first?.c?.[0]);
  if (!Number.isFinite(price) || price <= 0) throw new KrakenError(`Sin precio para ${pair}`);
  return price;
}

export async function getBalance() {
  return privateCall('Balance');
}

/** Compra a mercado `volume` unidades del par indicado. */
export async function marketBuy(pair, volume) {
  const result = await privateCall('AddOrder', {
    pair,
    type: 'buy',
    ordertype: 'market',
    volume: String(volume),
  });
  return { txid: result?.txid?.[0] || null, descr: result?.descr?.order || null };
}

export async function getWithdrawInfo({ asset, key, amount }) {
  return privateCall('WithdrawInfo', { asset, key, amount: String(amount) });
}

/**
 * Retira a una direccion previamente dada de alta en Kraken.
 * `key` es el nombre con el que la direccion esta guardada en Kraken:
 * la API no permite retirar a direcciones arbitrarias no incluidas en la lista blanca.
 */
export async function withdraw({ asset, key, amount }) {
  const result = await privateCall('Withdraw', { asset, key, amount: String(amount) });
  return { refid: result?.refid || null };
}

export async function getWithdrawStatus(asset) {
  return privateCall('WithdrawStatus', { asset });
}

/** Comprueba credenciales y permisos; util para el chequeo de estado del panel. */
export async function ping() {
  if (!config.kraken.live) {
    return { ok: true, mode: config.kraken.mode, simulated: true };
  }
  try {
    const balance = await getBalance();
    return { ok: true, mode: 'live', assets: Object.keys(balance || {}).length };
  } catch (err) {
    logger.warn('kraken: ping fallido', err);
    return { ok: false, mode: 'live', error: err.message };
  }
}

export default { getPrice, getBalance, marketBuy, withdraw, getWithdrawInfo, getWithdrawStatus, ping, signRequest };
