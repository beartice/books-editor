import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cerca la radice del progetto (il pacchetto "books-editor") salendo i livelli.
 * Funziona sia in sviluppo (server/src) sia dopo la build (server/dist/server/src)
 * e dentro l'immagine Docker.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJson = path.join(dir, 'package.json');
    if (fs.existsSync(packageJson)) {
      try {
        const content = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { name?: string };
        if (content.name === 'books-editor') return dir;
      } catch {
        /* package.json illeggibile: si continua a salire */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..', '..');
}

export const PROJECT_ROOT = findProjectRoot(here);

function envPath(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

export const DATA_DIR = envPath('DATA_DIR', path.join(PROJECT_ROOT, 'data'));
export const DEFAULT_LIBRARY_ROOT = envPath('LIBRARY_ROOT', path.join(PROJECT_ROOT, 'library'));
/** Cartella che contiene le librerie aggiuntive: una sottocartella per ciascuna. */
export const LIBRARIES_ROOT = envPath('LIBRARIES_ROOT', path.join(PROJECT_ROOT, 'librerie'));

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '0.0.0.0';

/** Dimensione massima di un file caricato dal browser, in MB (1-4096, default 300). */
export const MAX_UPLOAD_MB = (() => {
  const value = Number(process.env.MAX_UPLOAD_MB);
  return Number.isInteger(value) && value >= 1 && value <= 4096 ? value : 300;
})();
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Se LIBRARY_ROOT e' definita nell'ambiente, la cartella della libreria non e' modificabile. */
export const LIBRARY_ROOT_LOCKED = Boolean(process.env.LIBRARY_ROOT?.trim());

/** Autenticazione con pagina di login e sessione (deployment su server pubblico). */
export const AUTH_USER = process.env.AUTH_USER ?? '';
export const AUTH_PASS = process.env.AUTH_PASS ?? '';
/** Hash scrypt della password: `scrypt$N$r$p$<saltBase64>$<hashBase64>`. */
export const AUTH_PASS_HASH = process.env.AUTH_PASS_HASH?.trim() ?? '';
/** In produzione consente esplicitamente di avviare senza autenticazione. */
export const AUTH_DISABLED = ['1', 'true'].includes((process.env.AUTH_DISABLED ?? '').trim().toLowerCase());
export const SESSION_SECRET_ENV = process.env.SESSION_SECRET ?? '';
export const SESSION_DAYS = (() => {
  const days = Number(process.env.SESSION_DAYS ?? 30);
  return Number.isFinite(days) && days > 0 ? days : 30;
})();

/** Valore per l'opzione `trustProxy` di Fastify (sintassi proxy-addr); `false` se assente. */
export const TRUST_PROXY: boolean | number | string = (() => {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
})();

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Origini CORS consentite; vuoto = nessun CORS (app same-origin). */
export const CORS_ORIGINS = envList('CORS_ORIGINS').map((origin) => origin.replace(/\/+$/, ''));
/** Cartelle da cui «Importa da percorso» puo' leggere (assolute). */
export const IMPORT_ROOTS = envList('IMPORT_ROOTS').map((dir) => path.resolve(dir));

/**
 * Controllo automatico dei nuovi capitoli delle fanfiction (AO3, EFP).
 * `FANFIC_CHECK=off` lo disattiva; parte ogni giorno all'ora locale `FANFIC_CHECK_HOUR`
 * (0-23, default 3); fra una richiesta e l'altra passano `FANFIC_CHECK_DELAY_SEC` secondi.
 */
export const FANFIC_CHECK_ENABLED = !['off', '0', 'false', 'no'].includes(
  (process.env.FANFIC_CHECK ?? '').trim().toLowerCase(),
);
export const FANFIC_CHECK_HOUR = (() => {
  const value = Number(process.env.FANFIC_CHECK_HOUR);
  return process.env.FANFIC_CHECK_HOUR?.trim() && Number.isInteger(value) && value >= 0 && value <= 23
    ? value
    : 3;
})();
export const FANFIC_CHECK_DELAY_SEC = (() => {
  const value = Number(process.env.FANFIC_CHECK_DELAY_SEC);
  return process.env.FANFIC_CHECK_DELAY_SEC?.trim() && Number.isFinite(value) && value >= 0 ? value : 6;
})();

export const WEB_DIST = path.join(PROJECT_ROOT, 'web', 'dist');

export function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
