import path from 'node:path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import cron from 'node-cron';
import config from './config.js';
import logger from './lib/logger.js';
import { formatMoney } from './lib/money.js';
import { etiqueta } from './lib/labels.js';
import db from './lib/db.js';
import { SqliteSessionStore } from './lib/session-store.js';
import { csrfMiddleware } from './lib/csrf.js';
import { loadUser } from './middleware/auth.js';
import stripeWebhook from './routes/webhook-stripe.js';
import authRoutes from './routes/auth.js';
import panelRoutes from './routes/panel.js';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';
import { runDailyPayouts } from './services/payouts.js';

export const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(config.root, 'src', 'views'));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    // El panel no necesita aislar recursos de otros origenes; simplifica el despliegue tras proxy.
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
  })
);

// El webhook de Stripe va antes del parser JSON: necesita el cuerpo tal cual para la firma.
app.use(stripeWebhook);

app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: '7d' }));

app.use(
  session({
    name: 'panel.sid',
    secret: config.sessionSecret,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: config.sessionTtlHours * 3600 * 1000,
    },
  })
);

// Las variables comunes se definen antes que nada para que hasta la pagina de
// error del control CSRF tenga todo lo que necesita para pintarse.
app.use((req, res, next) => {
  res.locals.appName = 'Panel de cobros';
  res.locals.appUrl = config.appUrl;
  res.locals.currency = config.currency;
  res.locals.formatMoney = formatMoney;
  res.locals.etiqueta = etiqueta;
  res.locals.csrfToken = '';
  res.locals.user = null;
  res.locals.currentPath = req.path;
  next();
});

app.use(loadUser);
app.use(csrfMiddleware);

app.get('/', (req, res) => res.redirect(req.user ? '/panel' : '/login'));
app.use(apiRoutes);
app.use(authRoutes);
app.use(panelRoutes);
app.use(adminRoutes);

app.use((req, res) => {
  res.status(404).render('error', { title: 'No encontrado', message: 'Esta pagina no existe.' });
});

app.use((err, req, res, _next) => {
  logger.error('error no controlado', { path: req.path, error: err.message, stack: err.stack });
  if (res.headersSent) return;
  const message = config.isProd ? 'Ha ocurrido un error inesperado.' : err.message;
  // Si hasta la plantilla de error falla, se responde en texto plano.
  res.status(500).render('error', { title: 'Error', message }, (renderErr, html) => {
    if (renderErr) return res.type('text').send(`Error: ${message}`);
    res.send(html);
  });
});

export function startScheduler() {
  if (!config.payouts.autoEnabled) {
    logger.info('pagos automaticos desactivados (PAYOUT_AUTO=false)');
    return null;
  }
  if (!cron.validate(config.payouts.cron)) {
    logger.error('PAYOUT_CRON no es una expresion cron valida', { cron: config.payouts.cron });
    return null;
  }
  const task = cron.schedule(
    config.payouts.cron,
    () => {
      runDailyPayouts().catch((err) => logger.error('fallo en los pagos diarios', err));
    },
    { timezone: config.payouts.timezone }
  );
  logger.info('pagos diarios programados', { cron: config.payouts.cron, tz: config.payouts.timezone });
  return task;
}

// Solo arranca el servidor cuando se ejecuta el fichero directamente (los tests importan `app`).
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const server = app.listen(config.port, config.host, () => {
    logger.info('panel en marcha', {
      url: config.appUrl,
      puerto: config.port,
      entorno: config.env,
      kraken: config.kraken.live ? 'live' : 'simulate',
    });
  });
  const scheduler = startScheduler();

  const shutdown = (signal) => {
    logger.info('cerrando', { signal });
    scheduler?.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
