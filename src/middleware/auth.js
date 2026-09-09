import db from '../lib/db.js';

/** Carga el usuario de la sesion en req.user / res.locals.user. */
export function loadUser(req, res, next) {
  req.user = null;
  const userId = req.session?.userId;
  if (userId) {
    const user = db
      .prepare('SELECT id, username, role, display_name, fee_pct, telegram_chat_id, active, must_change_password FROM users WHERE id = ?')
      .get(userId);
    if (user && user.active) {
      req.user = user;
    } else {
      req.session.destroy(() => {});
    }
  }
  res.locals.user = req.user;
  res.locals.currentPath = req.path;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts('html')) {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({ error: 'no autenticado' });
  }
  // Contrasena provisional entregada por el admin: hay que cambiarla antes de seguir.
  if (req.user.must_change_password && !req.path.startsWith('/password') && req.path !== '/logout') {
    if (req.accepts('html')) return res.redirect('/password');
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', {
      title: 'Sin permiso',
      message: 'Esta seccion es solo para el administrador.',
    });
  }
  next();
}
