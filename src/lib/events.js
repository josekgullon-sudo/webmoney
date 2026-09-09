import { EventEmitter } from 'node:events';

/**
 * Bus interno para empujar novedades al panel por SSE (Server-Sent Events),
 * de modo que un cobro de Stripe aparece sin recargar la pagina.
 */
class PanelEvents extends EventEmitter {}

export const panelEvents = new PanelEvents();
panelEvents.setMaxListeners(0);

/** @param {{type: string, userId?: number|null, data?: any}} event */
export function publish(event) {
  panelEvents.emit('panel', { ...event, ts: new Date().toISOString() });
}

export default panelEvents;
