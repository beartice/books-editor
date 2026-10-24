import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR, ensureDir } from './config.js';
import { BROWSER_USER_AGENT } from './providers/fanfic.js';
import { STATUS_MARKER, isTransientAo3Status, runCurl, withAo3Retry } from './providers/ao3http.js';
import { saveAo3Session } from './providers/ao3session.js';

/**
 * Accesso ad AO3 con il proprio account. Si passa dal form di login (token
 * CSRF + POST) usando curl, come per le altre richieste ad AO3. La password
 * viaggia solo nello stdin di curl (mai negli argomenti del processo) e non
 * viene salvata ne' scritta nei log: del login resta solo il cookie jar.
 */

const LOGIN_URL = 'https://archiveofourown.org/users/login';

/** Errore con il codice HTTP da restituire al client. */
export class Ao3LoginError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BLOCKED = 'AO3 o Cloudflare ha bloccato la richiesta: riprova fra qualche minuto';

const COMMON_ARGS = [
  '-q',
  '-sS',
  '-L',
  '--compressed',
  '--connect-timeout',
  '8',
  '--max-time',
  '30',
  '-A',
  BROWSER_USER_AGENT,
  '-H',
  'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  '-H',
  'Accept-Language: en-US,en;q=0.9,it;q=0.8',
];

/** Come `curlPageOnce`, ma riprova gli errori temporanei di Cloudflare (es. 525). */
async function curlPage(
  args: string[],
  url: string,
  stdin?: string,
): Promise<{ status: number; body: string }> {
  return withAo3Retry(
    async () => {
      const page = await curlPageOnce(args, url, stdin);
      if (isTransientAo3Status(page.status)) throw new TransientPage(page);
      return page;
    },
    (error) => (error instanceof TransientPage ? error.page.status : 0),
  ).catch((error: unknown) => {
    // Dopo l'ultimo tentativo si restituisce la pagina: decide chi chiama.
    if (error instanceof TransientPage) return error.page;
    throw error;
  });
}

class TransientPage extends Error {
  constructor(readonly page: { status: number; body: string }) {
    super(`HTTP ${page.status}`);
  }
}

async function curlPageOnce(
  args: string[],
  url: string,
  stdin?: string,
): Promise<{ status: number; body: string }> {
  let out: string;
  try {
    out = await runCurl(
      [...COMMON_ARGS, ...args, '-w', STATUS_MARKER + '%{http_code}', '--', url],
      { stdin, timeoutMs: 35_000 },
    );
  } catch (error) {
    throw new Ao3LoginError(502, (error as Error).message);
  }
  const index = out.lastIndexOf(STATUS_MARKER);
  if (index === -1) throw new Ao3LoginError(502, 'AO3 non ha restituito una risposta valida');
  return {
    status: Number.parseInt(out.slice(index + STATUS_MARKER.length).trim(), 10),
    body: out.slice(0, index),
  };
}

function decodeAttr(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Token CSRF della pagina di login: meta `csrf-token` oppure input del form. */
export function extractAuthenticityToken(html: string): string | null {
  const meta =
    html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i)?.[1];
  const input =
    html.match(/<input[^>]+name=["']authenticity_token["'][^>]+value=["']([^"']+)["']/i)?.[1] ??
    html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']authenticity_token["']/i)?.[1];
  const token = input ?? meta;
  return token ? decodeAttr(token) : null;
}

/** Messaggio per un login non riuscito per colpa di AO3/Cloudflare. */
function blockedMessage(status: number): string {
  if (isTransientAo3Status(status)) {
    return `AO3 ha un problema temporaneo (errore ${status} di Cloudflare): riprova fra qualche minuto`;
  }
  return BLOCKED;
}

function isCloudflare(status: number, body: string): boolean {
  return (
    status === 403 ||
    status === 429 ||
    status >= 500 ||
    /cf-error-details|just a moment|challenge-platform/i.test(body)
  );
}

/** Configurazione per `curl -K -`: i dati del form non passano dagli argomenti. */
function curlConfigWithData(data: string): string {
  const quoted = data.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `data = "${quoted}"\n`;
}

/**
 * Esegue l'accesso e salva la sessione. Lancia Ao3LoginError: 401 per
 * credenziali errate, 502 se AO3 o Cloudflare non rispondono.
 */
export async function loginAo3(username: string, password: string): Promise<void> {
  ensureDir(DATA_DIR);
  const jar = path.join(DATA_DIR, `ao3-login-${randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(jar, '', { mode: 0o600 });
  try {
    const page = await curlPage(['-c', jar], LOGIN_URL);
    if (isCloudflare(page.status, page.body)) throw new Ao3LoginError(502, blockedMessage(page.status));
    const token = extractAuthenticityToken(page.body);
    if (!token) throw new Ao3LoginError(502, 'AO3 ha restituito una pagina di accesso inattesa');

    const form = new URLSearchParams({
      'user[login]': username,
      'user[password]': password,
      'user[remember_me]': '1',
      authenticity_token: token,
      commit: 'Log In',
    }).toString();
    const result = await curlPage(
      ['-b', jar, '-c', jar, '-e', LOGIN_URL, '-K', '-'],
      LOGIN_URL,
      curlConfigWithData(form),
    );
    if (isCloudflare(result.status, result.body)) throw new Ao3LoginError(502, blockedMessage(result.status));
    // Riuscito: la pagina finale ha il link «Log Out» (oppure «Hi, <utente>»).
    if (!/\/users\/logout|>\s*Log Out\s*</i.test(result.body)) {
      throw new Ao3LoginError(401, 'Utente o password AO3 errati');
    }
    await saveAo3Session(jar, username);
  } finally {
    await fsp.rm(jar, { force: true });
  }
}
