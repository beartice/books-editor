import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { BROWSER_USER_AGENT } from './fanfic.js';
import { ao3CookieHeader, withAo3Jar } from './ao3session.js';

const execFileAsync = promisify(execFile);

/** Programma curl; `AO3_CURL` lo sostituisce (prove con un finto curl). */
const curlBin = () => process.env.AO3_CURL || 'curl';

const STATUS_MARKER = '\n__AO3_HTTP_STATUS__:';

/** Errore HTTP di AO3 con il codice di stato, per distinguere 404 e limiti di richieste. */
export class Ao3HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Errori temporanei fra Cloudflare e AO3 (per esempio 525 «SSL handshake
 * failed», che AO3 restituisce a caso per alcune richieste): vale la pena
 * riprovare. 429 e 503 no: li gestisce chi chiama, con attese piu' lunghe.
 */
export function isTransientAo3Status(status: number): boolean {
  return status === 502 || status === 504 || (status >= 520 && status <= 526);
}

/** Pausa prima del ritentativo n (0, 1, ...): 3 s, poi 7 s. AO3_RETRY_DELAY_MS la cambia (prove). */
function retryDelayMs(attempt: number): number {
  const base = Number(process.env.AO3_RETRY_DELAY_MS ?? 3000);
  return Math.round((Number.isFinite(base) ? base : 3000) * (attempt === 0 ? 1 : 2.3));
}

const AO3_ATTEMPTS = 3;

/** Esegue `task` e lo ripete fino a 3 volte se AO3 risponde con un errore temporaneo. */
export async function withAo3Retry<T>(
  task: () => Promise<T>,
  statusOf: (error: unknown) => number = (error) => (error instanceof Ao3HttpError ? error.status : 0),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!isTransientAo3Status(statusOf(error)) || attempt >= AO3_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
}

/**
 * Ultima spiaggia quando né curl né Node riescono a raggiungere AO3: un
 * lettore pubblico che restituisce l'HTML originale della pagina. Serve solo
 * per contenuti AO3 pubblici e viene usato dopo i tentativi diretti.
 */
export async function fetchAo3WithReader(url: string, timeoutMs: number): Promise<string> {
  const target = new URL(url);
  if (/\/works\/\d+/i.test(target.pathname)) {
    // Le pagine delle opere complete sono più facili da recuperare per il reader.
    target.searchParams.set('view_full_work', 'true');
  }

  let response: Response;
  try {
    response = await fetch(`https://r.jina.ai/${target.toString()}`, {
      headers: {
        Accept: 'text/html',
        'X-Return-Format': 'html',
        'User-Agent': 'books-editor/1.0',
      },
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') {
      throw new Error('AO3 non risponde (timeout)');
    }
    throw new Error(`AO3 non raggiungibile: ${(error as Error).message}`);
  }

  if (!response.ok) throw new Error(`AO3 non raggiungibile (HTTP ${response.status})`);
  const html = await response.text();
  if (/404 Error \| Archive of Our Own/i.test(html)) {
    throw new Error('AO3 non trova la pagina (potrebbe essere stata eliminata)');
  }
  if (!html.trim()) throw new Error('AO3 non ha restituito una pagina valida');
  return html;
}

/**
 * AO3 è dietro Cloudflare: le richieste fatte con il client TLS di Node
 * ricevono spesso 525/403 anche quando il sito è raggiungibile. Curl usa una
 * connessione TLS diversa e nella pratica riesce molto più spesso, quindi lo
 * usiamo come trasporto preferito per le pagine delle serie.
 *
 * Il comando è sempre eseguito senza shell e l'URL è costruito dal chiamante
 * solo con ID numerici AO3.
 */
export async function fetchAo3WithCurl(
  url: string,
  timeoutMs: number,
  maxSeconds = 15,
): Promise<string> {
  return withAo3Retry(() => fetchAo3WithCurlOnce(url, timeoutMs, maxSeconds));
}

async function fetchAo3WithCurlOnce(
  url: string,
  timeoutMs: number,
  maxSeconds: number,
): Promise<string> {
  const seconds = Math.max(1, Math.min(maxSeconds, Math.ceil(timeoutMs / 1000)));
  const args = [
    // Ignora un eventuale ~/.curlrc dell'utente: la richiesta deve essere
    // riproducibile sul server.
    '-q',
    '-sS',
    '-L',
    '--compressed',
    '--connect-timeout',
    String(Math.max(1, Math.min(5, seconds))),
    '--max-time',
    String(seconds),
    '-A',
    BROWSER_USER_AGENT,
    '-H',
    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    '-H',
    'Accept-Language: en-US,en;q=0.9,it;q=0.8',
    '-H',
    'Sec-Fetch-Dest: document',
    '-H',
    'Sec-Fetch-Mode: navigate',
    '-H',
    'Sec-Fetch-Site: none',
    '-H',
    'Sec-Fetch-User: ?1',
    '-H',
    'Upgrade-Insecure-Requests: 1',
    '-w',
    STATUS_MARKER + '%{http_code}',
  ];

  let stdout: string;
  try {
    // Con l'accesso ad AO3 la richiesta porta i cookie della sessione.
    const result = await withAo3Jar((jarArgs) =>
      execFileAsync(curlBin(), [...args, ...jarArgs, '--', url], {
        encoding: 'utf8',
        maxBuffer: 12 * 1024 * 1024,
        timeout: (seconds + 2) * 1000,
      }),
    );
    stdout = result.stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      const missing = new Error('curl non disponibile');
      (missing as NodeJS.ErrnoException).code = 'ENOENT';
      throw missing;
    }
    const killed = (error as { killed?: boolean }).killed;
    const signal = (error as { signal?: string }).signal;
    if (code === 28 || code === '28' || killed || signal === 'SIGTERM') {
      throw new Error('AO3 non risponde (timeout)');
    }
    const message = (error as Error).message.replace(/^Command failed:[\s\S]*$/, '').trim();
    throw new Error(`AO3 non raggiungibile${message ? `: ${message}` : ''}`);
  }

  const markerIndex = stdout.lastIndexOf(STATUS_MARKER);
  if (markerIndex === -1) throw new Error('AO3 non ha restituito una risposta valida');

  const status = Number.parseInt(stdout.slice(markerIndex + STATUS_MARKER.length).trim(), 10);
  const body = stdout.slice(0, markerIndex);
  if (status === 404) {
    throw new Ao3HttpError(404, 'AO3 non trova la pagina (potrebbe essere stata eliminata)');
  }
  if (status < 200 || status >= 300) {
    throw new Ao3HttpError(status, `AO3 non raggiungibile (HTTP ${status})`);
  }
  return body;
}

/**
 * Variante binaria di `fetchAo3WithCurl`: scarica un file (l'EPUB di un'opera)
 * direttamente su disco con `-o`, senza passare dalla memoria di Node. Stessa
 * connessione TLS di curl, che Cloudflare lascia passare piu' spesso.
 * Senza curl usa il fetch di Node. Il file viene scritto in `destination`
 * solo se la risposta e' 2xx.
 */
export async function downloadAo3File(
  url: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  return withAo3Retry(() => downloadAo3FileOnce(url, destination, timeoutMs));
}

async function downloadAo3FileOnce(
  url: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = [
    '-q',
    '-sS',
    '-L',
    '--connect-timeout',
    '10',
    '--max-time',
    String(seconds),
    '-A',
    BROWSER_USER_AGENT,
    '-H',
    'Accept: application/epub+zip,application/octet-stream,*/*;q=0.8',
    '-H',
    'Accept-Language: en-US,en;q=0.9,it;q=0.8',
    '-o',
    destination,
    '-w',
    '%{http_code}',
  ];

  let status: number;
  try {
    const result = await withAo3Jar((jarArgs) =>
      execFileAsync(curlBin(), [...args, ...jarArgs, '--', url], {
        encoding: 'utf8',
        timeout: (seconds + 2) * 1000,
      }),
    );
    status = Number.parseInt(result.stdout.trim(), 10);
  } catch (error) {
    await fsp.rm(destination, { force: true });
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return downloadAo3WithFetch(url, destination, timeoutMs);
    const killed = (error as { killed?: boolean }).killed;
    if (code === 28 || code === '28' || killed) throw new Error('AO3 non risponde (timeout)');
    throw new Error('AO3 non raggiungibile durante il download');
  }
  if (status < 200 || status >= 300) {
    await fsp.rm(destination, { force: true });
    if (status === 404) throw new Ao3HttpError(404, 'AO3 non trova il file (potrebbe essere stato eliminato)');
    throw new Ao3HttpError(status, `AO3 non raggiungibile (HTTP ${status})`);
  }
}

/** Ripiego senza curl (es. Windows): fetch di Node, scritto su disco. */
async function downloadAo3WithFetch(
  url: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  let response: Response;
  try {
    const cookie = ao3CookieHeader();
    response = await fetch(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: '*/*', ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') throw new Error('AO3 non risponde (timeout)');
    throw new Error(`AO3 non raggiungibile: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Ao3HttpError(response.status, `AO3 non raggiungibile (HTTP ${response.status})`);
  }
  await fsp.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/**
 * Esegue curl senza shell. Il corpo di una richiesta con dati sensibili (la
 * password dell'accesso) si passa da `stdin` come configurazione (`-K -`): non
 * compare mai fra gli argomenti del processo. Lo stderr di curl non viene
 * conservato ne' riportato negli errori.
 */
export function runCurl(
  args: string[],
  options: { stdin?: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(curlBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 12 * 1024 * 1024) chunks.push(chunk);
    });
    child.stderr.on('data', () => undefined);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const failure = new Error(error.code === 'ENOENT' ? 'curl non disponibile' : 'curl non eseguibile');
      (failure as NodeJS.ErrnoException).code = error.code;
      reject(failure);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('AO3 non risponde (timeout)'));
      if (code !== 0) return reject(new Error('AO3 non raggiungibile'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });
}

export { STATUS_MARKER };
