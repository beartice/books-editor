import type { SeriesVolume } from '../../../shared/types.js';

const BASE_URL = 'https://www.goodreads.com';
const MIN_REQUEST_INTERVAL = 3500;
const REQUEST_TIMEOUT = 10000;
const TOTAL_BUDGET = 30000;
const MAX_ISBNS = 2;

/**
 * Goodreads non offre più un'API pubblica e le pagine di ricerca sono vietate
 * ai crawler. Usiamo solo pagine consentite da robots.txt: /book/isbn/...,
 * /book/show/... e /series/... . La ricerca avviene a partire dall'ISBN di un
 * volume già presente nella libreria, quindi non serve /search.
 */
const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

interface GoodreadsSeriesListProps {
  series?: Array<{
    book?: {
      bookId?: string | number;
      bookUrl?: string;
      title?: string;
      bookTitleBare?: string;
      imageUrl?: string;
      publicationDate?: string;
      author?: { name?: string };
    };
  }>;
  seriesHeaders?: string[];
}

const cookieJar = new Map<string, string>();
let nextRequestAt = 0;
let requestChain: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rememberCookies(headers: Headers): void {
  const cookies = headers.getSetCookie?.() ?? [];
  for (const raw of cookies) {
    const first = raw.split(';', 1)[0] ?? '';
    const separator = first.indexOf('=');
    if (separator <= 0) continue;
    cookieJar.set(first.slice(0, separator).trim(), first.slice(separator + 1).trim());
  }
}

function cookieHeader(): string {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function queuedFetch(url: string, referer?: string): Promise<Response> {
  const run = async (): Promise<Response> => {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL;

    const headers = new Headers(BROWSER_HEADERS);
    const cookies = cookieHeader();
    if (cookies) headers.set('Cookie', cookies);
    if (referer) headers.set('Referer', referer);

    return fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  };

  const result = requestChain.then(run, run);
  requestChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isChallengePage(html: string): boolean {
  if (html.length < 20000) {
    return (
      /captcha|challenge|robot|automated access|attention required|just a moment|cf-browser-verification/i.test(
        html,
      ) || !/<html[\s>]/i.test(html)
    );
  }
  return /attention required!?\s*\|\s*cloudflare|cf-browser-verification|just a moment\.\.\./i.test(
    html,
  );
}

async function fetchPage(
  url: string,
  referer?: string,
): Promise<{ html: string; finalUrl: string }> {
  const response = await queuedFetch(url, referer);
  rememberCookies(response.headers);

  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `Goodreads ha limitato le richieste (HTTP ${response.status}). Riprova tra qualche minuto.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Goodreads non ha risposto correttamente (HTTP ${response.status}).`);
  }

  const html = await response.text();
  if (isChallengePage(html)) {
    throw new Error(
      'Goodreads ha mostrato una verifica anti-bot. Riprova tra qualche minuto.',
    );
  }

  return { html, finalUrl: response.url || url };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractSeriesUrl(html: string, series: string): string | null {
  const candidates: string[] = [];
  for (const match of html.matchAll(/href=(?:"([^"]+)"|'([^']+)')/g)) {
    const raw = decodeHtml(match[1] ?? match[2] ?? '').trim();
    if (!raw || !/\/series\/\d+/i.test(raw)) continue;
    try {
      const url = new URL(raw, BASE_URL);
      if (!/(^|\.)goodreads\.com$/i.test(url.hostname)) continue;
      if (!/^\/series\/\d+/i.test(url.pathname)) continue;
      const value = url.toString();
      if (!candidates.includes(value)) candidates.push(value);
    } catch {
      // Un href malformato non deve interrompere la ricerca.
    }
  }

  const target = normalize(series);
  return (
    candidates.find((candidate) => normalize(new URL(candidate).pathname).includes(target)) ??
    candidates[0] ??
    null
  );
}

function parseIndex(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/(?:book\s*|#)\s*(\d+(?:[.,]\d+)?)/i);
  if (!match) return null;
  const number = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(number) || number <= 0 || number >= 1000) return null;
  return number;
}

function cleanTitle(value: string): string {
  const cleaned = value
    .replace(/\s*\([^)]*#\s*\d+(?:[.,]\d+)?[^)]*\)\s*$/i, '')
    .replace(/\s*\([^)]*\bbook\s*\d+[^)]*\)\s*$/i, '')
    .trim();
  return cleaned || value.trim();
}

function isCompilation(title: string): boolean {
  return /\b(?:box(?:ed)?\s*set|complete\s+series|omnibus|bundle|slipcase|series\s+set)\b/i.test(
    title,
  );
}

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';

  const iso = raw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (iso) return iso[3] ? `${iso[1]}-${iso[2]}-${iso[3]}` : `${iso[1]}-${iso[2]}`;

  const year = raw.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return year?.[1] ?? '';
}

function extractSeriesListProps(html: string): GoodreadsSeriesListProps[] {
  const lists: GoodreadsSeriesListProps[] = [];
  const pattern = /<div[^>]*data-react-props=(?:"([^"]*)"|'([^']*)')[^>]*>/g;
  for (const match of html.matchAll(pattern)) {
    if (!/data-react-class="ReactComponents\.SeriesList"/.test(match[0])) continue;
    try {
      const parsed = JSON.parse(decodeHtml(match[1] ?? match[2] ?? '')) as GoodreadsSeriesListProps;
      if (parsed && typeof parsed === 'object') lists.push(parsed);
    } catch {
      // Se una delle liste è malformata, proviamo comunque con le altre.
    }
  }
  return lists;
}

function parseSeriesVolumes(html: string): SeriesVolume[] {
  const volumes: SeriesVolume[] = [];

  for (const props of extractSeriesListProps(html)) {
    const items = Array.isArray(props.series) ? props.series : [];
    const headers = Array.isArray(props.seriesHeaders) ? props.seriesHeaders : [];

    items.forEach((item, position) => {
      const book = item?.book;
      if (!book) return;

      const title = cleanTitle(String(book.bookTitleBare || book.title || '').trim());
      if (!title || isCompilation(title)) return;

      const index =
        parseIndex(headers[position]) ??
        parseIndex(book.title) ??
        parseIndex(book.bookTitleBare);
      const bookUrl = String(book.bookUrl ?? '').trim();
      let url: string | null = null;
      if (bookUrl) {
        try {
          url = new URL(bookUrl, BASE_URL).toString();
        } catch {
          url = null;
        }
      }

      volumes.push({
        index,
        title,
        subtitle: '',
        authors: book.author?.name ? [book.author.name] : [],
        releaseDate: normalizeDate(book.publicationDate),
        provider: 'goodreads',
        providerLabel: 'Goodreads',
        url,
        coverUrl: book.imageUrl ? String(book.imageUrl) : null,
        isbn: '',
      });
    });
  }

  return volumes;
}

function normalizeIsbn(value: string): string {
  return value.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function isValidIsbn(value: string): boolean {
  return /^\d{13}$/.test(value) || /^\d{9}[\dX]$/.test(value);
}

function dedupe(volumes: SeriesVolume[]): SeriesVolume[] {
  const seen = new Set<string>();
  return volumes.filter((volume) => {
    const key =
      volume.index !== null
        ? `i:${volume.index}`
        : `t:${normalize(volume.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cerca i volumi di una serie partendo dagli ISBN dei libri posseduti.
 * Restituisce [] se il libro non è collegato a una serie o se non ci sono ISBN.
 */
export async function lookupGoodreadsSeries(
  series: string,
  _authors: string[],
  isbns: string[],
): Promise<SeriesVolume[]> {
  const cleanIsbns = [...new Set(isbns.map(normalizeIsbn).filter(isValidIsbn))].slice(0, MAX_ISBNS);
  if (cleanIsbns.length === 0) return [];

  const deadline = Date.now() + TOTAL_BUDGET;
  let lastError: Error | null = null;
  for (const isbn of cleanIsbns) {
    try {
      if (Date.now() >= deadline) {
        lastError = new Error('la ricerca ha impiegato troppo tempo. Riprova più tardi.');
        break;
      }
      const bookPage = await fetchPage(
        `${BASE_URL}/book/isbn/${encodeURIComponent(isbn)}`,
      );
      const seriesUrl = extractSeriesUrl(bookPage.html, series);
      if (!seriesUrl) continue;
      if (Date.now() >= deadline) {
        lastError = new Error('la ricerca ha impiegato troppo tempo. Riprova più tardi.');
        break;
      }

      const seriesPage = await fetchPage(seriesUrl, bookPage.finalUrl);
      const volumes = dedupe(parseSeriesVolumes(seriesPage.html));
      if (volumes.length > 0) return volumes;

      // La pagina è stata caricata ma non conteneva il blocco React atteso.
      // Un altro ISBN dello stesso libro porterebbe alla stessa serie.
      lastError = new Error(
        `formato della pagina serie non riconosciuto per «${series}».`,
      );
      break;
    } catch (error) {
      lastError = error as Error;
      // Una verifica anti-bot non migliora ritentando subito con un altro ISBN.
      if (/anti-bot|limitato le richieste/i.test(lastError.message)) break;
    }
  }

  if (lastError) throw lastError;
  return [];
}
