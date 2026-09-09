import crypto from 'node:crypto';

/** Token CSRF por sesion, comparado en tiempo constante. */
export function csrfMiddleware(req, res, next) {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session?.csrfToken || '';

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sent = req.body?._csrf || req.get('x-csrf-token') || '';
  const expected = req.session?.csrfToken || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('error', {
      title: 'Sesion caducada',
      message: 'El formulario ha caducado. Vuelve a intentarlo.',
    });
  }
  next();
}

export default csrfMiddleware;
