import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import db, { audit } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';

export const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos. Prueba de nuevo en unos minutos.',
});

function safeNext(value) {
  // Solo rutas internas: evita redirecciones abiertas hacia otro dominio.
  return typeof value === 'string' && /^\/[^/\\]/.test(value) ? value : '/panel';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/panel');
  res.render('login', { title: 'Entrar', error: null, next: safeNext(req.query.next) });
});

router.post('/login', loginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next_ = safeNext(req.body.next);

  const fail = () =>
    res.status(401).render('login', {
      title: 'Entrar',
      error: 'Usuario o contrasena incorrectos.',
      next: next_,
    });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Se compara siempre contra un hash para no filtrar por tiempo si el usuario existe.
  const hash = user?.password_hash || '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok || !user.active) {
    audit(user?.id ?? null, 'login.failed', { entity: 'user', entityId: user?.id, details: { username }, ip: req.ip });
    return fail();
  }

  req.session.regenerate((err) => {
    if (err) return fail();
    req.session.userId = user.id;
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    audit(user.id, 'login.ok', { entity: 'user', entityId: user.id, ip: req.ip });
    req.session.save(() => res.redirect(user.must_change_password ? '/password' : next_));
  });
});

router.post('/logout', requireAuth, (req, res) => {
  const userId = req.user.id;
  req.session.destroy(() => {
    audit(userId, 'logout', { entity: 'user', entityId: userId, ip: req.ip });
    res.redirect('/login');
  });
});

router.get('/password', requireAuth, (req, res) => {
  res.render('password', {
    title: 'Cambiar contrasena',
    error: null,
    ok: false,
    forced: Boolean(req.user.must_change_password),
  });
});

router.post('/password', requireAuth, async (req, res) => {
  const current = String(req.body.current || '');
  const next_ = String(req.body.password || '');
  const repeat = String(req.body.repeat || '');
  const render = (error, ok = false) =>
    res.render('password', {
      title: 'Cambiar contrasena',
      error,
      ok,
      forced: Boolean(req.user.must_change_password),
    });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(current, row.password_hash))) {
    return render('La contrasena actual no es correcta.');
  }
  if (next_.length < 10) return render('La nueva contrasena debe tener al menos 10 caracteres.');
  if (next_ !== repeat) return render('Las dos contrasenas nuevas no coinciden.');
  if (next_ === current) return render('La nueva contrasena debe ser distinta de la actual.');

  const hash = await bcrypt.hash(next_, 12);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?")
    .run(hash, req.user.id);
  audit(req.user.id, 'password.change', { entity: 'user', entityId: req.user.id, ip: req.ip });
  req.user.must_change_password = 0;
  render(null, true);
});

export default router;
