import type { SeriesVolume } from '../../../shared/types.js';
import { fetchAo3Html } from './fanfic.js';
import { fetchAo3WithCurl, fetchAo3WithReader } from './ao3http.js';

const SERIES_CACHE_TTL = 6 * 60 * 60 * 1000;
const SERIES_ID_CACHE_TTL = 24 * 60 * 60 * 1000;
/**
 * AO3/Cloudflare risponde spesso 525 (errore temporaneo del nodo). I tentativi
 * sono rapidi, ma il tempo complessivo resta sotto il timeout tipico di un
 * reverse proxy: meglio un errore chiaro che una richiesta appesa.
 */
const AO3_BUDGET = 22_000;
const AO3_REQUEST_TIMEOUT = 8_000;
const AO3_ATTEMPTS = 4;

const seriesCache = new Map<string, { at: number; volumes: SeriesVolume[] }>();
const seriesIdCache = new Map<string, { at: number; id: string | null }>();

/**
 * Cerca le opere che compongono una serie AO3. Il link salvato nella libreria
 * è quello della singola opera: la pagina dell'opera contiene il rimando alla
 * serie, che poi elenca tutte le parti (con numero e data di pubblicazione).
 */
export async function lookupAo3Series(
  urls: string[],
  options: { refresh?: boolean } = {},
): Promise<SeriesVolume[]> {
  const targets = [...new Set(urls.map((url) => url.trim()).filter(Boolean))].slice(0, 8);
  if (targets.length === 0) return [];

  const deadline = Date.now() + AO3_BUDGET;
  let lastError: Error | null = null;
  for (const target of targets) {
    try {
      const seriesId = await resolveSeriesId(target, Boolean(options.refresh), deadline);
      if (!seriesId) continue;
      return await fetchSeries(seriesId, Boolean(options.refresh), deadline);
    } catch (error) {
      lastError = error as Error;
    }
  }

  if (lastError) throw lastError;
  return [];
}

let curlAvailable: boolean | null = null;

async function fetchAo3Once(
  url: string,
  timeoutMs: number,
  deadline: number,
): Promise<string> {
  if (curlAvailable !== false) {
    try {
      const html = await fetchAo3WithCurl(url, timeoutMs);
      curlAvailable = true;
      return html;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      curlAvailable = false;
    }
  }

  // Senza curl (es. Windows) restiamo sul client HTTP di Node.
  return fetchAo3Html(url, {
    timeoutMs,
    attempts: 1,
    retryTimeouts: true,
    deadline,
  });
}

async function fetchAo3Page(
  urls: string[],
  deadline: number,
  isValid: (html: string) => boolean,
): Promise<string> {
  let lastError: Error | null = null;
  // Teniamo da parte un po' di tempo per il reader esterno, che spesso
  // funziona quando Cloudflare rifiuta la connessione diretta.
  const directDeadline = Math.max(Date.now() + 2000, deadline - 15_000);

  for (const url of urls) {
    for (let attempt = 0; attempt < AO3_ATTEMPTS; attempt += 1) {
      const remaining = directDeadline - Date.now();
      if (remaining < 1200) break;

      try {
        const html = await fetchAo3Once(
          url,
          Math.min(AO3_REQUEST_TIMEOUT, remaining),
          deadline,
        );
        if (isValid(html)) return html;
        lastError = new Error('AO3 ha restituito una pagina inattesa');
      } catch (error) {
        lastError = error as Error;
        if (/non trova la pagina/i.test(lastError.message)) throw lastError;
      }

      if (directDeadline - Date.now() < 1200) break;
      await sleep(100 + attempt * 100);
    }
  }

  const remaining = deadline - Date.now();
  if (remaining > 2000) {
    try {
      const html = await fetchAo3WithReader(urls[0], Math.min(15_000, remaining));
      if (isValid(html)) return html;
      lastError = new Error('AO3 ha restituito una pagina inattesa');
    } catch (error) {
      lastError = error as Error;
    }
  }

  if (lastError) throw lastError;
  throw new Error('AO3 non ha risposto in tempo');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Il dominio con `www` è un secondo tentativo: a volte evita un edge KO. */
function pageVariants(url: URL): string[] {
  const www = new URL(url.toString());
  www.hostname = 'www.archiveofourown.org';
  return [url.toString(), www.toString()];
}

async function resolveSeriesId(
  input: string,
  refresh: boolean,
  deadline: number,
): Promise<string | null> {
  const direct = input.match(/\/series\/(\d+)/i)?.[1];
  if (direct) return direct;

  const workId =
    input.match(/\/works\/(\d+)/i)?.[1] ?? (/^\d+$/.test(input.trim()) ? input.trim() : null);
  if (!workId) return null;

  const workUrl = `https://archiveofourown.org/works/${workId}`;
  const cached = seriesIdCache.get(workUrl);
  if (!refresh && cached && Date.now() - cached.at < SERIES_ID_CACHE_TTL) return cached.id;

  const html = await fetchAo3Page(
    pageVariants(new URL(workUrl)),
    deadline,
    (page) =>
      /work meta group/i.test(page) ||
      /class=["'][^"']*\bwork blurb\b/i.test(page) ||
      /id=["']work_\d+/i.test(page),
  );
  const id =
    html.match(
      /<dd\b[^>]*class=["'][^"']*\bseries\b[^"']*["'][^>]*>[\s\S]*?href=["']\/series\/(\d+)["']/i,
    )?.[1] ??
    html.match(/href=["']\/series\/(\d+)["']/i)?.[1] ??
    null;

  seriesIdCache.set(workUrl, { at: Date.now(), id });
  return id;
}

async function fetchSeries(
  seriesId: string,
  refresh: boolean,
  deadline: number,
): Promise<SeriesVolume[]> {
  const cached = seriesCache.get(seriesId);
  if (!refresh && cached && Date.now() - cached.at < SERIES_CACHE_TTL) return cached.volumes;

  const volumes: SeriesVolume[] = [];
  const seen = new Set<string>();

  // Le serie molto lunghe sono divise in pagine. Ci fermiamo alla prima
  // pagina senza nuove opere: evita richieste inutili alla fine dell'elenco.
  for (let page = 1; page <= 20; page += 1) {
    if (deadline - Date.now() < 1200) throw new Error('AO3 non ha risposto in tempo');

    const url = new URL(`https://archiveofourown.org/series/${seriesId}`);
    if (page > 1) url.searchParams.set('page', String(page));

    const html = await fetchAo3Page(
      pageVariants(url),
      deadline,
      (candidate) => /id=["']work_\d+/i.test(candidate),
    );
    const pageVolumes = parseSeriesPage(html, seriesId);

    let added = 0;
    for (const volume of pageVolumes) {
      const key = volume.url ?? `${volume.index ?? 'x'}:${volume.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      volumes.push(volume);
      added += 1;
    }

    if (added === 0 || !hasNextPage(html)) break;
  }

  // Una serie AO3 contiene almeno un'opera: una pagina vuota è quasi sempre
  // una risposta di Cloudflare o un link non più valido.
  if (volumes.length === 0) {
    throw new Error('AO3 non ha restituito le opere della serie');
  }

  seriesCache.set(seriesId, { at: Date.now(), volumes });
  return volumes;
}

function hasNextPage(html: string): boolean {
  return (
    /<a\b[^>]*\brel=["']next["']/i.test(html) ||
    /<a\b[^>]*class=["'][^"']*\bnext\b[^"']*["']/i.test(html)
  );
}

function parseSeriesPage(html: string, seriesId: string): SeriesVolume[] {
  const starts = [...html.matchAll(/<li\b[^>]*\bid=["']work_(\d+)["'][^>]*>/gi)];
  const volumes: SeriesVolume[] = [];

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const from = (start.index ?? 0) + start[0].length;
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? html.length) : html.length;
    const block = html.slice(from, to);

    const header =
      block.match(/<h4\b[^>]*class=["'][^"']*heading[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i)?.[1] ??
      block;
    const title = stripHtml(
      header.match(/<a\b[^>]*href=["'][^"']*\/works\/\d+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '',
    );
    if (!title) continue;

    const authors = [
      ...new Set(
        [...header.matchAll(/<a\b[^>]*rel=["']author["'][^>]*>([\s\S]*?)<\/a>/gi)]
          .map((match) => stripHtml(match[1]))
          .filter(Boolean),
      ),
    ];

    const dateHtml =
      block.match(
        /<p\b[^>]*class=["'][^"']*\bdatetime\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
      )?.[1] ?? '';
    const workId = start[1];
    const index = seriesPosition(block, seriesId);

    volumes.push({
      index,
      title,
      subtitle: '',
      authors,
      releaseDate: parseAo3Date(dateHtml),
      provider: 'ao3',
      providerLabel: 'AO3',
      url: `https://archiveofourown.org/works/${workId}`,
      coverUrl: null,
      isbn: '',
    });
  }

  return volumes;
}

/** Estrae «Part 3 of» solo quando il rimando è alla serie che stiamo leggendo. */
function seriesPosition(block: string, seriesId: string): number | null {
  const pattern =
    /Part\s*(?:<strong>)?\s*(\d+)\s*(?:<\/strong>)?\s*of\s*[\s\S]{0,80}?\/series\/(\d+)/gi;
  for (const match of block.matchAll(pattern)) {
    if (match[2] === seriesId) {
      const index = Number.parseInt(match[1], 10);
      if (Number.isFinite(index) && index > 0) return index;
    }
  }
  return null;
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function parseAo3Date(value: string): string {
  const text = stripHtml(value);
  if (!text) return '';

  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;

  const written = text.match(/\b(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})\b/);
  if (written) {
    const month = MONTHS[written[2].toLowerCase()];
    if (month) return `${written[3]}-${month}-${written[1].padStart(2, '0')}`;
  }

  const year = text.match(/\b(\d{4})\b/);
  return year ? year[1] : '';
}

function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : '';
    })
    .replace(/&#(\d+);/g, (_, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : '';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo);/gi, (_, entity: string) => {
      const map: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        hellip: '…',
        mdash: '—',
        ndash: '–',
        lsquo: '‘',
        rsquo: '’',
        ldquo: '“',
        rdquo: '”',
      };
      return map[entity.toLowerCase()] ?? '';
    });
}
