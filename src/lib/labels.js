// Los estados se guardan en ingles en la base de datos (es lo que devuelven
// Stripe y Kraken); aqui se traducen para mostrarlos en el panel.

const ESTADOS = {
  // Cobros
  succeeded: 'cobrado',
  refunded: 'devuelto',
  disputed: 'reclamado',
  canceled: 'cancelado',
  // Pagos a cartera
  pending: 'pendiente',
  trading: 'comprando',
  withdrawing: 'enviando',
  sent: 'enviado',
  failed: 'fallido',
  // Carteras
  approved: 'aprobada',
  rejected: 'rechazada',
  // Avisos
  skipped: 'omitido',
  // Roles
  admin: 'administrador',
  user: 'usuario',
};

export function etiqueta(valor) {
  return ESTADOS[String(valor || '').toLowerCase()] || valor || '';
}

export default etiqueta;
