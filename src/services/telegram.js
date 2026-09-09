import config from '../config.js';
import db from '../lib/db.js';
import logger from '../lib/logger.js';

const API = 'https://api.telegram.org';

export function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function record(target, text, status, error) {
  try {
    db.prepare(
      'INSERT INTO notifications (channel, target, text, status, error) VALUES (?, ?, ?, ?, ?)'
    ).run('telegram', target ?? null, text, status, error ?? null);
  } catch (err) {
    logger.warn('no se pudo registrar la notificacion', err);
  }
}

/**
 * Envia un mensaje por el bot de Telegram. Nunca lanza: un fallo de Telegram
 * no debe tumbar el webhook de Stripe ni el proceso de pagos.
 */
export async function sendTelegram(chatId, text, { silent = false } = {}) {
  const target = String(chatId || '').trim();
  if (!config.telegram.enabled) {
    record(target, text, 'skipped', 'TELEGRAM_BOT_TOKEN no configurado');
    return { ok: false, skipped: true };
  }
  if (!target) {
    record(target, text, 'skipped', 'sin chat_id destino');
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch(`${API}/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: target,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: silent,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const error = body.description || `HTTP ${res.status}`;
      record(target, text, 'failed', error);
      logger.warn('telegram: envio fallido', { target, error });
      return { ok: false, error };
    }
    record(target, text, 'sent', null);
    return { ok: true };
  } catch (err) {
    record(target, text, 'failed', err.message);
    logger.warn('telegram: error de red', err);
    return { ok: false, error: err.message };
  }
}

/** Avisa al admin y, si lo tiene configurado, tambien al usuario implicado. */
export async function notify(text, { userChatId } = {}) {
  const targets = new Set();
  if (config.telegram.adminChatId) targets.add(String(config.telegram.adminChatId));
  if (userChatId) targets.add(String(userChatId));
  if (targets.size === 0) {
    record(null, text, 'skipped', 'sin destinatarios configurados');
    return;
  }
  await Promise.all([...targets].map((chatId) => sendTelegram(chatId, text)));
}
