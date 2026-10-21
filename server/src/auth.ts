import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AUTH_DISABLED,
  AUTH_PASS,
  AUTH_PASS_HASH,
  AUTH_USER,
  CORS_ORIGINS,
  DATA_DIR,
  DEFAULT_LIBRARY_ROOT,
  IS_PRODUCTION,
  LIBRARY_ROOT_LOCKED,
  SESSION_DAYS,
  SESSION_SECRET_ENV,
  ensureDir,
} from './config.js';
import { prepareLibraryRoot } from './libraryRoot.js';
import { loadSettings, saveSettings } from './store.js';
import { scanLibrary } from './library.js';

const COOKIE_NAME = 'be_session';
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const FAIL_DELAY_MS = 500;

/* ------------------------------------------------------------ password -- */

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Crea l'hash scrypt `scrypt$N$r$p$<salt>$<hash>` di una password. */
export async function hashPassword(password: string): Promise<string> {
  const N = 32768;
  const r = 8;
  const p = 1;
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, 64, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(value: string): ParsedHash | null {
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N < 2 || (N & (N - 1)) !== 0 || N > 1 << 20) {
    return null;
  }
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { N, r, p, salt, hash };
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/** Confronto a tempo costante fra due stringhe (tramite SHA-256). */
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/* ----------------------------------------------------- credenziali -- */

/** Origine delle credenziali: variabili d'ambiente o file `DATA_DIR/auth.json`. */
export type CredentialsSource = 'env' | 'file';

interface Credentials {
  source: CredentialsSource;
  user: string;
  parsed: ParsedHash | null;
  plain: string;
  /** Incrementato a ogni cambio password: invalida le sessioni esistenti. */
  sessionVersion: number;
  createdAt: string;
}

interface AuthFile {
  version: 1;
  user: string;
  passHash: string;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
}

const AUTH_FILE = () => path.join(DATA_DIR, 'auth.json');
const SETUP_CODE_FILE = () => path.join(DATA_DIR, '.setup-code');

/** Credenziali attive; null = nessun account (modalita' configurazione o app aperta). */
let credentials: Credentials | null = null;
let stateLoaded = false;

function readAuthFile(): Credentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(AUTH_FILE(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`auth.json illeggibile: ${(error as Error).message}`);
  }
  let data: Partial<AuthFile>;
  try {
    data = JSON.parse(raw) as Partial<AuthFile>;
  } catch {
    throw new Error('auth.json non e\' un JSON valido (cancellalo per rifare la configurazione iniziale)');
  }
  const parsed = typeof data.passHash === 'string' ? parseHash(data.passHash) : null;
  if (typeof data.user !== 'string' || !data.user || !parsed) {
    throw new Error('auth.json non valido (cancellalo per rifare la configurazione iniziale)');
  }
  const sessionVersion = Number.isInteger(data.sessionVersion) ? (data.sessionVersion as number) : 0;
  return {
    source: 'file',
    user: data.user,
    parsed,
    plain: '',
    sessionVersion,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
  };
}

/** Calcola le credenziali: prima l'ambiente, poi auth.json. Lancia se la configurazione e' invalida. */
function loadState(): void {
  if (AUTH_USER) {
    const parsed = AUTH_PASS_HASH ? parseHash(AUTH_PASS_HASH) : null;
    if (AUTH_PASS_HASH && !parsed) {
      throw new Error('AUTH_PASS_HASH non valido: atteso il formato scrypt$N$r$p$<salt>$<hash> (usa lo script hash-password)');
    }
    if (!AUTH_PASS_HASH && !AUTH_PASS) {
      throw new Error('AUTH_USER e\' impostato ma mancano AUTH_PASS_HASH (consigliato) o AUTH_PASS');
    }
    credentials = { source: 'env', user: AUTH_USER, parsed, plain: AUTH_PASS, sessionVersion: 0, createdAt: '' };
  } else {
    credentials = readAuthFile();
  }
  stateLoaded = true;
}

/** Nessun account e autenticazione non disattivata esplicitamente: serve la configurazione. */
function setupRequired(): boolean {
  return !credentials && !AUTH_DISABLED;
}

/** Autenticazione attiva (account presente o configurazione da fare): l'app non e' mai aperta. */
function authEnabled(): boolean {
  return Boolean(credentials) || !AUTH_DISABLED;
}

async function verifyPassword(creds: Credentials, password: string): Promise<boolean> {
  if (creds.parsed) {
    const { parsed } = creds;
    const key = await scryptAsync(password, parsed.salt, parsed.hash.length, parsed.N, parsed.r, parsed.p);
    return crypto.timingSafeEqual(key, parsed.hash);
  }
  return safeEqual(password, creds.plain);
}

/** Validazione di nome utente e password (uguale a quella del client). */
function validateNewCredentials(username: string | null, password: string): string | null {
  if (username !== null) {
    if (username !== username.trim()) return 'Il nome utente non puo\' avere spazi all\'inizio o alla fine';
    if (username.length < 3 || username.length > 64) return 'Il nome utente deve avere da 3 a 64 caratteri';
  }
  if (password.length < 10) return 'La password deve avere almeno 10 caratteri';
  if (password.length > 1024) return 'La password e\' troppo lunga (massimo 1024 caratteri)';
  if (username !== null && password === username) return 'La password deve essere diversa dal nome utente';
  return null;
}

/** Scrive auth.json in modo atomico (file temporaneo + link/rename), permessi 0600. */
async function writeAuthFile(file: AuthFile, mode: 'create' | 'replace'): Promise<'ok' | 'exists'> {
  const target = AUTH_FILE();
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    if (mode === 'replace') {
      await fsp.rename(tmp, target);
    } else {
      // link fallisce con EEXIST se il file esiste gia': vince la prima richiesta.
      await fsp.link(tmp, target);
      await fsp.unlink(tmp);
    }
    await fsp.chmod(target, 0o600).catch(() => undefined);
    return 'ok';
  } catch (error) {
    await fsp.unlink(tmp).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw error;
  }
}

/* ------------------------------------------------ codice di configurazione -- */

// 32 simboli senza caratteri ambigui (niente 0, O, I, L): 12 simboli = 60 bit.
const CODE_ALPHABET = '123456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_FORMAT = /^[1-9A-HJKMNP-Z]{4}-[1-9A-HJKMNP-Z]{4}-[1-9A-HJKMNP-Z]{4}$/;

function generateSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

/** Legge il codice salvato o ne crea uno nuovo (stabile fra un riavvio e l'altro). */
function ensureSetupCode(): string {
  ensureDir(DATA_DIR);
  const file = SETUP_CODE_FILE();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim().toUpperCase();
    if (CODE_FORMAT.test(existing)) return existing;
  } catch {
    /* file assente: se ne genera uno nuovo */
  }
  const code = generateSetupCode();
  fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return code;
}

const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Richiesta "locale": IP di loopback e nessuna intestazione di proxy. Dietro un
 * proxy (nginx sull'host arriva da loopback) la richiesta NON e' locale.
 */
function isLocalRequest(request: FastifyRequest): boolean {
  const h = request.headers;
  if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-forwarded-proto'] || h['forwarded'] || h['x-real-ip']) {
    return false;
  }
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
}

/* ------------------------------------------------------------- sessione -- */

let sessionSecret = '';

function loadSessionSecret(): string {
  if (SESSION_SECRET_ENV) {
    if (SESSION_SECRET_ENV.length < 32) throw new Error('SESSION_SECRET deve avere almeno 32 caratteri');
    return SESSION_SECRET_ENV;
  }
  ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* file assente: se ne genera uno nuovo */
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

function createToken(user: string, sessionVersion: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ u: user, sv: sessionVersion, iat: now, exp: now + Math.round(SESSION_DAYS * 86400) })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: string; sv?: number; exp?: number };
    if (typeof data.u !== 'string' || typeof data.exp !== 'number') return null;
    if (data.exp * 1000 <= Date.now()) return null;
    if (!credentials || (data.sv ?? 0) !== credentials.sessionVersion) return null;
    return safeEqual(data.u, credentials.user) ? data.u : null;
  } catch {
    return null;
  }
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionUser(request: FastifyRequest): string | null {
  const token = readCookie(request, COOKIE_NAME);
  return token ? verifyToken(token) : null;
}

function cookieHeader(request: FastifyRequest, value: string, maxAgeSeconds: number): string {
  const attrs = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (request.protocol === 'https') attrs.push('Secure');
  return attrs.join('; ');
}

/* ------------------------------------------------- limite dei tentativi -- */

interface Attempts {
  failures: number[];
  blockedUntil: number;
}
const attempts = new Map<string, Attempts>();

function blockedSeconds(ip: string): number {
  const entry = attempts.get(ip);
  if (!entry || entry.blockedUntil <= Date.now()) return 0;
  return Math.ceil((entry.blockedUntil - Date.now()) / 1000);
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip) ?? { failures: [], blockedUntil: 0 };
  entry.failures = entry.failures.filter((time) => now - time < WINDOW_MS);
  entry.failures.push(now);
  if (entry.failures.length >= MAX_FAILURES) {
    entry.blockedUntil = now + WINDOW_MS;
    entry.failures = [];
  }
  attempts.set(ip, entry);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ avvio/hook -- */

/** Controlla la configurazione all'avvio; lancia un errore chiaro se non valida. */
export function checkAuthConfig(): void {
  loadState();
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Percorso da usare per i controlli di sicurezza: la rotta abbinata da Fastify
 * (es. "/api/books/:id"), altrimenti il percorso decodificato. Mai l'URL grezzo:
 * il router decodifica i %xx, quindi "/%61pi/books" raggiunge "/api/books" e un
 * controllo su request.url lo lascerebbe passare senza login.
 */
function securityPath(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (route) return route;
  const raw = request.url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname.toLowerCase().startsWith('/api/');
}

export function registerAuth(app: FastifyInstance): void {
  if (!stateLoaded) loadState();
  if (authEnabled()) sessionSecret = loadSessionSecret();
  if (credentials?.source === 'env' && !credentials.parsed && IS_PRODUCTION) {
    app.log.warn('AUTH_PASS in chiaro: in produzione usa AUTH_PASS_HASH (script hash-password)');
  }

  if (setupRequired()) {
    const code = ensureSetupCode();
    const lines = [
      'CONFIGURAZIONE INIZIALE: nessun account creato.',
      'Apri l\'app nel browser e crea l\'account.',
      `Codice di configurazione: ${code}`,
      'Lo ritrovi nei log del server o nel file .setup-code (cartella dei dati).',
    ];
    const width = Math.max(...lines.map((line) => line.length));
    const border = '+' + '-'.repeat(width + 2) + '+';
    for (const line of [border, ...lines.map((l) => `| ${l.padEnd(width)} |`), border]) app.log.warn(line);
    app.log.info(`File del codice di configurazione: ${SETUP_CODE_FILE()}`);
  } else {
    // Con un account presente un vecchio codice non serve piu'.
    fs.rmSync(SETUP_CODE_FILE(), { force: true });
  }

  // Pulizia periodica della mappa dei tentativi.
  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attempts) {
      if (entry.blockedUntil <= now && entry.failures.every((time) => now - time >= WINDOW_MS)) attempts.delete(ip);
    }
  }, 10 * 60 * 1000);
  cleaner.unref();

  /* Difesa CSRF di seconda linea (la prima e' SameSite=Strict). */
  const allowedOrigins = new Set(CORS_ORIGINS.map((origin) => hostOf(origin)).filter(Boolean) as string[]);
  app.addHook('onRequest', async (request, reply) => {
    if (!isApiPath(securityPath(request))) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const source = (request.headers.origin as string | undefined) ?? (request.headers.referer as string | undefined);
    if (!source) return;
    const host = hostOf(source);
    const own = String(request.host ?? '').toLowerCase();
    if (host && (host === own || allowedOrigins.has(host))) return;
    // In sviluppo il proxy di Vite cambia l'Host: si accettano le origini locali.
    if (!IS_PRODUCTION && host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return;
    return reply.code(403).send({ error: 'Origine della richiesta non consentita' });
  });

  /* Accesso: tutto /api/* richiede la sessione, tranne health, login, me e setup.
     In modalita' configurazione restano aperti solo health, me e setup. */
  const open = new Set(['/api/health', '/api/auth/login', '/api/auth/me', '/api/auth/setup']);
  const openInSetup = new Set(['/api/health', '/api/auth/me', '/api/auth/setup']);
  app.addHook('onRequest', async (request, reply) => {
    const pathname = securityPath(request);
    if (!isApiPath(pathname)) return;
    if (setupRequired()) {
      if (openInSetup.has(pathname)) return;
      return reply.code(403).send({ error: 'Configurazione iniziale richiesta', setupRequired: true });
    }
    if (!credentials) return; // AUTH_DISABLED senza account: app aperta
    if (open.has(pathname)) return;
    if (!sessionUser(request)) return reply.code(401).send({ error: 'Accesso richiesto' });
  });

  const lockedReply = (reply: FastifyReply, ip: string) => {
    const wait = blockedSeconds(ip);
    if (wait <= 0) return false;
    reply.header('Retry-After', String(wait));
    reply.code(429).send({ error: 'Troppi tentativi', retryAfter: wait });
    return true;
  };

  const startSession = (request: FastifyRequest, reply: FastifyReply, creds: Credentials) => {
    reply.header('Set-Cookie', cookieHeader(request, createToken(creds.user, creds.sessionVersion), Math.round(SESSION_DAYS * 86400)));
  };

  app.post<{ Body: { username?: unknown; password?: unknown } }>('/api/auth/login', async (request, reply) => {
    const creds = credentials;
    if (!creds) return reply.code(400).send({ error: 'Autenticazione non attiva' });
    const ip = request.ip;
    if (lockedReply(reply, ip)) return reply;
    const username = typeof request.body?.username === 'string' ? request.body.username : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    // Si verificano sempre entrambi, cosi' i tempi non rivelano quale era sbagliato.
    const userOk = safeEqual(username, creds.user);
    const passOk = password.length <= 1024 && (await verifyPassword(creds, password));
    if (!(userOk && passOk)) {
      recordFailure(ip);
      await sleep(FAIL_DELAY_MS);
      return reply.code(401).send({ error: 'Nome utente o password errati' });
    }
    attempts.delete(ip);
    startSession(request, reply, creds);
    return { ok: true, user: creds.user };
  });

  app.post<{ Body: { username?: unknown; password?: unknown; setupCode?: unknown; libraryRoot?: unknown } }>(
    '/api/auth/setup',
    async (request, reply) => {
      if (!setupRequired()) return reply.code(409).send({ error: 'Account già configurato' });
      const ip = request.ip;
      if (lockedReply(reply, ip)) return reply;
      const username = typeof request.body?.username === 'string' ? request.body.username : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      const given = typeof request.body?.setupCode === 'string' ? request.body.setupCode : '';

      // Il codice serve solo per le richieste non locali.
      if (!isLocalRequest(request)) {
        const expected = ensureSetupCode();
        if (!safeEqual(normalizeCode(given), normalizeCode(expected))) {
          recordFailure(ip);
          await sleep(FAIL_DELAY_MS);
          return reply.code(403).send({ error: 'Codice di configurazione errato', setupCodeRequired: true });
        }
      }
      const invalid = validateNewCredentials(username, password);
      if (invalid) return reply.code(400).send({ error: invalid });

      // La cartella della libreria si convalida prima di creare l'account.
      const wantedRoot = typeof request.body?.libraryRoot === 'string' ? request.body.libraryRoot.trim() : '';
      let newRoot: string | null = null;
      if (LIBRARY_ROOT_LOCKED) {
        if (wantedRoot && path.resolve(wantedRoot) !== path.resolve(DEFAULT_LIBRARY_ROOT)) {
          return reply.code(400).send({
            error: 'La cartella della libreria e\' bloccata dalla variabile d\'ambiente LIBRARY_ROOT',
          });
        }
      } else if (wantedRoot) {
        const prepared = await prepareLibraryRoot(wantedRoot);
        if ('error' in prepared) return reply.code(400).send({ error: prepared.error });
        if (prepared.path !== path.resolve((await loadSettings()).libraryRoot)) newRoot = prepared.path;
      }

      const passHash = await hashPassword(password);
      const now = new Date().toISOString();
      const result = await writeAuthFile(
        { version: 1, user: username, passHash, sessionVersion: 0, createdAt: now, updatedAt: now },
        'create',
      );
      // Un'altra richiesta e' arrivata prima (o l'account esiste gia').
      if (result === 'exists') return reply.code(409).send({ error: 'Account già configurato' });
      credentials = readAuthFile();
      await fsp.rm(SETUP_CODE_FILE(), { force: true });
      if (!credentials) return reply.code(500).send({ error: 'Impossibile leggere l\'account appena creato' });
      attempts.delete(ip);
      startSession(request, reply, credentials);
      if (newRoot) {
        try {
          await saveSettings({ libraryRoot: newRoot });
          // Come dopo il cambio di cartella dalle impostazioni: i libri presenti compaiono.
          await scanLibrary();
        } catch (error) {
          app.log.error({ err: error }, 'Impossibile impostare o scansionare la cartella della libreria');
        }
      }
      return { ok: true, user: credentials.user };
    },
  );

  app.post<{ Body: { currentPassword?: unknown; newPassword?: unknown } }>('/api/auth/password', async (request, reply) => {
    const creds = credentials;
    if (!creds) return reply.code(400).send({ error: 'Autenticazione non attiva' });
    if (creds.source !== 'file') {
      return reply.code(400).send({ error: 'Credenziali gestite da variabili d\'ambiente' });
    }
    const ip = request.ip;
    if (lockedReply(reply, ip)) return reply;
    const current = typeof request.body?.currentPassword === 'string' ? request.body.currentPassword : '';
    const next = typeof request.body?.newPassword === 'string' ? request.body.newPassword : '';
    // Non 401: il client lo leggerebbe come sessione scaduta.
    if (current.length > 1024 || !(await verifyPassword(creds, current))) {
      recordFailure(ip);
      await sleep(FAIL_DELAY_MS);
      return reply.code(400).send({ error: 'La password attuale non e\' corretta' });
    }
    const invalid = validateNewCredentials(creds.user, next);
    if (invalid) return reply.code(400).send({ error: invalid });

    const now = new Date().toISOString();
    await writeAuthFile(
      {
        version: 1,
        user: creds.user,
        passHash: await hashPassword(next),
        sessionVersion: creds.sessionVersion + 1,
        createdAt: creds.createdAt,
        updatedAt: now,
      },
      'replace',
    );
    credentials = readAuthFile();
    attempts.delete(ip);
    if (credentials) startSession(request, reply, credentials);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('Set-Cookie', cookieHeader(request, '', 0));
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const needSetup = setupRequired();
    // Il percorso della libreria si mostra solo a chi e' in locale o se e' fissato dal server.
    const setupInfo = needSetup
      ? {
          setupLibraryRootLocked: LIBRARY_ROOT_LOCKED,
          setupLibraryRoot:
            isLocalRequest(request) || LIBRARY_ROOT_LOCKED ? (await loadSettings()).libraryRoot : null,
        }
      : {};
    const base = {
      ...setupInfo,
      setupRequired: needSetup,
      setupCodeRequired: needSetup && !isLocalRequest(request),
      credentialsSource: credentials?.source ?? null,
    };
    if (!credentials) return { authEnabled: !AUTH_DISABLED, authenticated: AUTH_DISABLED, user: null, ...base };
    const user = sessionUser(request);
    return { authEnabled: true, authenticated: Boolean(user), user, ...base };
  });
}
