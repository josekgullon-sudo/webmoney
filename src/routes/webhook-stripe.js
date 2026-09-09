import express from 'express';
import Stripe from 'stripe';
import config from '../config.js';
import db from '../lib/db.js';
import logger from '../lib/logger.js';
import { recordPayment, markPaymentStatus, announcePayment, resolveUser } from '../services/payments.js';
import { splitFee } from '../lib/money.js';
import { publish } from '../lib/events.js';

export const router = express.Router();

const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

/** Marca el evento como procesado; devuelve false si ya se habia procesado antes. */
function claimEvent(eventId, type) {
  try {
    db.prepare('INSERT INTO webhook_events (stripe_event_id, type) VALUES (?, ?)').run(eventId, type);
    return true;
  } catch {
    return false;
  }
}

/** Si el cobro llego sin usuario y este evento trae metadata util, se asigna ahora. */
function backfillUser(payment, metadata) {
  if (payment.user_id) return null;
  const user = resolveUser(metadata);
  if (!user) return null;
  const { feeCents, netCents } = splitFee(payment.gross_cents, user.fee_pct);
  db.prepare('UPDATE payments SET user_id = ?, fee_cents = ?, net_cents = ? WHERE id = ?')
    .run(user.id, feeCents, netCents, payment.id);
  publish({ type: 'payment', userId: user.id, data: { id: payment.id } });
  return user;
}

/**
 * Webhook de Stripe. Debe recibir el cuerpo sin parsear para poder verificar la firma,
 * por eso se monta con express.raw antes que express.json.
 */
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !config.stripe.webhookSecret) {
    logger.error('webhook de Stripe recibido sin STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET');
    return res.status(500).send('stripe no configurado');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (err) {
    logger.warn('firma de webhook invalida', err);
    return res.status(400).send(`firma invalida: ${err.message}`);
  }

  // Se responde 200 en cuanto el evento es valido y ya esta registrado: Stripe no
  // debe esperar a Telegram ni a la base de datos para dar el envio por bueno.
  if (!claimEvent(event.id, event.type)) {
    logger.debug('evento repetido, ignorado', { id: event.id });
    return res.json({ received: true, duplicate: true });
  }
  res.json({ received: true });

  try {
    await handleEvent(event);
  } catch (err) {
    logger.error('error procesando evento de Stripe', { id: event.id, type: event.type, error: err.message });
  }
});

async function handleEvent(event) {
  const object = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (object.payment_status !== 'paid') return;
      const objectId = typeof object.payment_intent === 'string' ? object.payment_intent : object.id;
      const metadata = object.metadata || {};
      const { created, payment, user } = recordPayment({
        objectId,
        eventId: event.id,
        grossCents: object.amount_total ?? 0,
        currency: object.currency || config.currency,
        description: object.description || 'Pago con Stripe Checkout',
        customerEmail: object.customer_details?.email || object.customer_email || null,
        metadata,
      });
      if (created) return announcePayment(payment, user);
      const assigned = backfillUser(payment, metadata);
      if (assigned) logger.info('cobro asignado a posteriori', { id: payment.id, userId: assigned.id });
      return;
    }

    case 'payment_intent.succeeded': {
      const metadata = object.metadata || {};
      const { created, payment, user } = recordPayment({
        objectId: object.id,
        eventId: event.id,
        grossCents: object.amount_received ?? object.amount ?? 0,
        currency: object.currency || config.currency,
        description: object.description || 'Pago con Stripe',
        customerEmail: object.receipt_email || null,
        metadata,
      });
      if (created) return announcePayment(payment, user);
      backfillUser(payment, metadata);
      return;
    }

    case 'charge.refunded': {
      const objectId = typeof object.payment_intent === 'string' ? object.payment_intent : object.id;
      const payment = markPaymentStatus(objectId, 'refunded');
      if (payment) publish({ type: 'payment', userId: payment.user_id, data: { id: payment.id } });
      return;
    }

    case 'charge.dispute.created': {
      const charge = object.charge;
      const pi = typeof object.payment_intent === 'string' ? object.payment_intent : charge;
      const payment = markPaymentStatus(pi, 'disputed');
      if (payment) publish({ type: 'payment', userId: payment.user_id, data: { id: payment.id } });
      return;
    }

    default:
      logger.debug('evento de Stripe no gestionado', { type: event.type });
  }
}

export default router;
