import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BROWSER_USER_AGENT } from './fanfic.js';

const execFileAsync = promisify(execFile);

const STATUS_MARKER = '\n__AO3_HTTP_STATUS__:';

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
export async function fetchAo3WithCurl(url: string, timeoutMs: number): Promise<string> {
  const seconds = Math.max(1, Math.min(15, Math.ceil(timeoutMs / 1000)));
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
    '--',
    url,
  ];

  let stdout: string;
  try {
    const result = await execFileAsync('curl', args, {
      encoding: 'utf8',
      maxBuffer: 12 * 1024 * 1024,
      timeout: (seconds + 2) * 1000,
    });
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
    throw new Error('AO3 non trova la pagina (potrebbe essere stata eliminata)');
  }
  if (status < 200 || status >= 300) {
    throw new Error(`AO3 non raggiungibile (HTTP ${status})`);
  }
  return body;
}
