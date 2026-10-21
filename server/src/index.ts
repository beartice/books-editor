import path from 'node:path';
import fsp from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { CORS_ORIGINS, DATA_DIR, IS_PRODUCTION, MAX_UPLOAD_BYTES, PORT, HOST, TRUST_PROXY, WEB_DIST, ensureDir } from './config.js';
import { checkAuthConfig, registerAuth } from './auth.js';
import { registerApi } from './routes.js';
import { loadSettings } from './store.js';
import { scanLibrary } from './library.js';

try {
  checkAuthConfig();
} catch (error) {
  console.error(`Configurazione non valida: ${(error as Error).message}`);
  process.exit(1);
}

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Cookie e credenziali non devono mai finire nei log.
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      censor: '[omesso]',
    },
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
  bodyLimit: 30 * 1024 * 1024,
  trustProxy: TRUST_PROXY as boolean | string,
});

// Senza CORS_ORIGINS l'app e' same-origin (in sviluppo Vite fa da proxy).
if (CORS_ORIGINS.length > 0) {
  await app.register(cors, { origin: CORS_ORIGINS, credentials: true });
}
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

/* Intestazioni di sicurezza. HSTS lo imposta nginx. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.addHook('onSend', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  // Vite in sviluppo usa script inline e websocket: la CSP solo in produzione.
  if (IS_PRODUCTION) reply.header('Content-Security-Policy', CSP);
});

/* Login con sessione, CSRF e controllo d'accesso su /api/*. */
registerAuth(app);

await registerApi(app);

/* Front-end statico (build di produzione). */
const webDistExists = await fsp
  .stat(WEB_DIST)
  .then(() => true)
  .catch(() => false);

if (webDistExists) {
  // Cache-Control deciso qui: gli asset di Vite hanno l'hash nel nome (immutabili),
  // index.html va sempre riconvalidato, il resto dura un'ora.
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const relative = path.relative(WEB_DIST, filePath).split(path.sep);
      const value =
        relative[0] === 'assets'
          ? 'public, max-age=31536000, immutable'
          : relative[0] === 'index.html'
            ? 'no-cache'
            : 'public, max-age=3600';
      res.setHeader('Cache-Control', value);
    },
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Endpoint inesistente' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Endpoint inesistente' });
    }
    return reply
      .code(404)
      .type('text/html')
      .send(
        '<h1>Front-end non compilato</h1><p>Avvia il dev server con <code>npm run dev</code> oppure esegui <code>npm run build</code>.</p>',
      );
  });
}

async function bootstrap(): Promise<void> {
  ensureDir(DATA_DIR);
  const settings = await loadSettings();
  ensureDir(settings.libraryRoot);

  try {
    const result = await scanLibrary();
    if (result.added || result.updated || result.removed) {
      app.log.info(
        { ...result, errors: result.errors.length },
        `Libreria sincronizzata: +${result.added} aggiunti, ${result.updated} aggiornati, ${result.removed} rimossi`,
      );
    }
  } catch (error) {
    app.log.error({ err: error }, 'Scansione iniziale fallita');
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Libreria: ${settings.libraryRoot}`);
  app.log.info(`Server in ascolto su http://${HOST}:${PORT}`);
}

bootstrap().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
