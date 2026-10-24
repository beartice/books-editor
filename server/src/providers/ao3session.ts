import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, ensureDir } from '../config.js';
import type { Ao3SessionState } from '../../../shared/types.js';

/**
 * Sessione AO3 dell'utente. Il server conserva SOLO i cookie della sessione
 * (formato cookie jar di curl) e il nome utente: la password non viene salvata.
 * I file stanno in DATA_DIR (escluso dal repository) con permessi 600.
 */

const jarFile = () => path.join(DATA_DIR, 'ao3-session.cookies');
const metaFile = () => path.join(DATA_DIR, 'ao3-session.json');

interface SessionMeta {
  username: string;
  loggedInAt: string;
  expired?: boolean;
}

function readMeta(): SessionMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaFile(), 'utf8')) as Partial<SessionMeta>;
    if (typeof parsed.username !== 'string' || !fs.existsSync(jarFile())) return null;
    return {
      username: parsed.username,
      loggedInAt: String(parsed.loggedInAt ?? ''),
      expired: parsed.expired === true,
    };
  } catch {
    return null;
  }
}

export function ao3SessionInfo(): Ao3SessionState {
  const meta = readMeta();
  if (!meta) return { loggedIn: false, username: null, loggedInAt: null };
  return {
    loggedIn: !meta.expired,
    username: meta.username,
    loggedInAt: meta.loggedInAt || null,
    ...(meta.expired ? { expired: true } : {}),
  };
}

/** true se c'e' una sessione utilizzabile (non scaduta). */
export function ao3SessionActive(): boolean {
  return ao3SessionInfo().loggedIn;
}

/** Scrittura atomica (file temporaneo + rename) con permessi 600. */
async function writeSecret(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, file);
}

/** Salva il cookie jar ottenuto dall'accesso e il nome utente (mai la password). */
export async function saveAo3Session(jarPath: string, username: string): Promise<void> {
  ensureDir(DATA_DIR);
  await writeSecret(jarFile(), await fsp.readFile(jarPath));
  const meta: SessionMeta = { username, loggedInAt: new Date().toISOString() };
  await writeSecret(metaFile(), JSON.stringify(meta, null, 2));
}

export async function clearAo3Session(): Promise<void> {
  await fsp.rm(jarFile(), { force: true });
  await fsp.rm(metaFile(), { force: true });
}

/** La sessione non vale piu' (AO3 mostra di nuovo il login): serve un nuovo accesso. */
export function markAo3SessionExpired(): void {
  const meta = readMeta();
  if (!meta || meta.expired) return;
  try {
    const file = metaFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...meta, expired: true }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* impossibile aggiornare: resta com'e' */
  }
}

/**
 * Esegue `fn` con gli argomenti curl del cookie jar (`-b`/`-c` su una copia
 * temporanea). Se `fn` riesce, il jar aggiornato dalle risposte sostituisce
 * quello salvato. Senza sessione utilizzabile `fn` riceve un elenco vuoto.
 */
export async function withAo3Jar<T>(fn: (jarArgs: string[]) => Promise<T>): Promise<T> {
  if (!ao3SessionActive()) return fn([]);
  const tmp = `${jarFile()}.${process.pid}.${randomBytes(4).toString('hex')}.use`;
  try {
    await fsp.copyFile(jarFile(), tmp);
    await fsp.chmod(tmp, 0o600);
  } catch {
    await fsp.rm(tmp, { force: true });
    return fn([]);
  }
  try {
    const result = await fn(['-b', tmp, '-c', tmp]);
    // Se nel frattempo si e' usciti, il jar non va ricreato.
    if (ao3SessionActive()) await fsp.rename(tmp, jarFile()).catch(() => undefined);
    return result;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** Intestazione `Cookie` per le richieste fatte con il client di Node, null senza sessione. */
export function ao3CookieHeader(): string | null {
  if (!ao3SessionActive()) return null;
  let text: string;
  try {
    text = fs.readFileSync(jarFile(), 'utf8');
  } catch {
    return null;
  }
  const now = Date.now() / 1000;
  const pairs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^#HttpOnly_/, '');
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , , , expires, name, value] = parts;
    if (!/(^|\.)archiveofourown\.org$/i.test(domain.replace(/^\./, ''))) continue;
    const expiry = Number(expires);
    if (expiry > 0 && expiry < now) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length ? pairs.join('; ') : null;
}
