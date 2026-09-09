import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function num(value, fallback) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET es obligatorio en produccion. Genera uno con: openssl rand -hex 32');
}

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  isProd,
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  // URL publica del panel (ej. https://mipanel.duckdns.org). Se usa en los avisos de Telegram.
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  // Necesario detras de Caddy/nginx para que las cookies "secure" y el rate limit funcionen.
  trustProxy: bool(process.env.TRUST_PROXY, false),
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'panel.db'),

  currency: (process.env.PLATFORM_CURRENCY || 'EUR').toUpperCase(),
  defaultFeePct: num(process.env.DEFAULT_FEE_PCT, 0),

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    get enabled() {
      return Boolean(this.secretKey);
    },
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    get enabled() {
      return Boolean(this.botToken);
    },
  },

  kraken: {
    apiKey: process.env.KRAKEN_API_KEY || '',
    apiSecret: process.env.KRAKEN_API_SECRET || '',
    // "simulate" no toca dinero real: registra la operacion y la marca como simulada.
    mode: (process.env.KRAKEN_MODE || 'simulate').toLowerCase(),
    // Si es false se asume que ya tienes el saldo en la cripto y solo se retira.
    tradeBeforeWithdraw: bool(process.env.KRAKEN_TRADE_BEFORE_WITHDRAW, true),
    get live() {
      return this.mode === 'live' && Boolean(this.apiKey && this.apiSecret);
    },
  },

  payouts: {
    // Por defecto: todos los dias a las 23:30.
    cron: process.env.PAYOUT_CRON || '30 23 * * *',
    timezone: process.env.PAYOUT_TIMEZONE || 'Europe/Madrid',
    autoEnabled: bool(process.env.PAYOUT_AUTO, true),
    minAmountCents: Math.round(num(process.env.PAYOUT_MIN_AMOUNT, 25) * 100),
  },
};

export default config;
