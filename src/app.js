import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { sessionLoader, requireMember, authRoutes } from './auth.js';
import { clinicalRoutes } from './routes/clinical.js';
import { adminRoutes } from './routes/admin.js';
import { errorHandler, HttpError } from './http.js';
import { ROLES, DEPARTMENTS } from './permissions.js';
import { SUMMARY_KINDS } from './summaries.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(pool, { idleMinutes = 15, trustProxy = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '200kb' }));

  // Cross-site request protection: cookies are SameSite=Strict, and every state-changing API
  // call must carry a custom header, which a form on another site cannot send.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.headers['x-wardbook'] !== '1') {
      return next(new HttpError(403, 'Request blocked: missing the WardBook header.'));
    }
    next();
  });

  app.get('/api/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
  app.get('/api/meta', (_req, res) => res.json({ roles: ROLES, departments: DEPARTMENTS, summaryKinds: SUMMARY_KINDS }));

  app.use('/api', sessionLoader(pool));
  app.use('/api/auth', authRoutes(pool, { idleMinutes }));
  app.use('/api/admin', requireMember(pool), adminRoutes(pool));
  app.use('/api', requireMember(pool), clinicalRoutes(pool));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
  app.use((_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use(errorHandler);
  return app;
}
