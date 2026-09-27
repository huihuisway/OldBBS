import 'reflect-metadata';
import { randomBytes, createHmac } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { RedisStore } from 'connect-redis';
import session from 'express-session';
import nunjucks from 'nunjucks';
import { createClient } from 'redis';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AuthService } from './auth/auth.service';
import { config } from './config';
import { AppModule } from './app.module';
import { renderMarkdown } from './common/content';
import { HtmlExceptionFilter } from './web/http-exception.filter';
import { validCsrfToken } from './common/csrf';
import { RateLimitService } from './common/rate-limit.service';

async function bootstrap() {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET is required. Copy .env.example to .env and set a random secret.');
  const redis = createClient({ socket: { host: config.redis.host, port: config.redis.port }, password: config.redis.password || undefined });
  redis.on('error', (error) => console.error('Redis error:', error.message));
  await redis.connect();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const dataSource = app.get(DataSource);
  const rateLimits = app.get(RateLimitService);
  rateLimits.configure(redis as any);
  app.use((req: any, res: any, next: () => void) => {
    if (req.path === '/healthz') return res.status(200).json({ status: 'ok' });
    if (req.path !== '/readyz') return next();
    void (async () => {
      const checks: Record<string, 'ok' | 'error'> = { database: 'error', redis: 'error' };
      try { await dataSource.query('SELECT 1'); checks.database = 'ok'; } catch { /* no sensitive diagnostics in health output */ }
      try { await redis.ping(); checks.redis = 'ok'; } catch { /* no sensitive diagnostics in health output */ }
      const ready = checks.database === 'ok' && checks.redis === 'ok';
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
    })().catch(next);
  });
  app.use(json({ limit: '512kb' }));
  app.use(urlencoded({ extended: true, limit: '512kb' }));
  app.set('trust proxy', config.trustProxy);
  app.use((req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(session({
    name: 'oldbbs.sid',
    secret: config.sessionSecret,
    store: new RedisStore({ client: redis, prefix: 'oldbbs:sess:' }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, secure: config.nodeEnv === 'production' || config.cookieSecure, sameSite: 'lax', maxAge: config.sessionTtlSeconds * 1000 },
  }));
  const auth = app.get(AuthService);
  app.use((req: any, res: any, next: () => void) => {
    const sessionObject = req.session;
    const continueRequest = () => {
      const activeSession = req.session;
      const needsFormToken = req.method === 'GET' && ['/login', '/register'].includes(req.path);
      if (activeSession && (activeSession.user || needsFormToken) && !activeSession.csrfToken) activeSession.csrfToken = randomBytes(24).toString('hex');
      res.locals.csrfToken = activeSession?.csrfToken ?? '';
      res.locals.currentUser = activeSession?.user ?? null;
      res.locals.lite = req.query.lite === '1' || req.cookies?.lite === '1' || activeSession?.user?.lowBandwidth === true;
      res.locals.path = req.path;
      if (req.method === 'POST') {
        const origin = req.get('origin');
        const referer = req.get('referer');
        const expectedHost = req.get('host');
        try {
          const suppliedOrigin = origin ? new URL(origin) : referer ? new URL(referer) : null;
          if (suppliedOrigin && (!expectedHost || suppliedOrigin.host !== expectedHost || suppliedOrigin.protocol !== `${req.secure ? 'https' : 'http'}:`)) {
            return res.status(403).render('errors/error.njk', { status: 403, message: 'This form expired. Please reload and try again.' });
          }
        } catch {
          return res.status(403).render('errors/error.njk', { status: 403, message: 'This form expired. Please reload and try again.' });
        }
        const isMultipart = String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data');
        if (!isMultipart && !validCsrfToken(activeSession?.csrfToken, req.body?._csrf, req.headers['x-csrf-token'])) {
          return res.status(403).render('errors/error.njk', { status: 403, message: 'This form expired. Please reload and try again.' });
        }
      }
      const signed = createHmac('sha256', config.sessionSecret).update(req.ip || '').digest('hex');
      req.requestFingerprint = signed;
      next();
    };
    if (sessionObject?.user) {
      void auth.validateSession(sessionObject.user.id, sessionObject.authVersion).then(async (user) => {
        if (user) {
          sessionObject.user = user;
        } else {
          delete sessionObject.user;
          delete sessionObject.authVersion;
          await new Promise<void>((resolve) => sessionObject.destroy(() => resolve()));
          res.clearCookie('oldbbs.sid');
        }
        continueRequest();
      }).catch(next);
      return;
    }
    continueRequest();
  });
  app.use((req: any, res: any, next: (error?: unknown) => void) => {
    const action = rateLimitedAction(req.method, req.path);
    if (!action) return next();
    void rateLimits.assertAllowed(action.name, { ip: req.ip || 'unknown' }, action.limit, action.windowMs)
      .then(() => next()).catch((error) => {
        if (error?.getStatus?.() === 429) return res.status(429).render('errors/error.njk', { status: 429, message: error.message });
        next(error);
      });
  });

  app.setBaseViewsDir(join(process.cwd(), 'views'));
  app.setViewEngine('njk');
  const views = nunjucks.configure(join(process.cwd(), 'views'), { autoescape: true, express: app.getHttpAdapter().getInstance(), noCache: config.nodeEnv !== 'production' });
  views.addFilter('markdown', renderMarkdown);
  app.useGlobalFilters(new HtmlExceptionFilter());
  app.useStaticAssets(join(process.cwd(), 'public'));
  app.enableShutdownHooks();
  await app.listen(config.appPort, config.appHost);
  console.log(`OldBBS web listening at ${config.appHost}:${config.appPort}`);
}

bootstrap().catch((error) => { console.error(error); process.exit(1); });

function rateLimitedAction(method: string, path: string): { name: string; limit: number; windowMs: number } | null {
  if (method === 'GET' && (path === '/search' || path === '/api/v1/search')) return { name: 'search', limit: 30, windowMs: 60_000 };
  if (method !== 'POST') return null;
  if (path === '/login' || path === '/register') return { name: 'auth', limit: 20, windowMs: 15 * 60_000 };
  if (path === '/threads' || path === '/api/v1/threads') return { name: 'thread.create', limit: 8, windowMs: 10 * 60_000 };
  if (path.includes('/replies') || path === '/api/v1/posts') return { name: 'post.create', limit: 20, windowMs: 10 * 60_000 };
  if (path === '/messages') return { name: 'message.create', limit: 12, windowMs: 10 * 60_000 };
  if (path === '/reports') return { name: 'report.create', limit: 8, windowMs: 60 * 60_000 };
  if (path === '/devices' || path === '/software') return { name: 'catalog.submit', limit: 8, windowMs: 60 * 60_000 };
  if (path === '/compatibility-reports') return { name: 'compatibility.submit', limit: 30, windowMs: 60 * 60_000 };
  if (path === '/terminal-keys') return { name: 'terminal-key.create', limit: 5, windowMs: 24 * 60 * 60_000 };
  return null;
}
