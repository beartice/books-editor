import { safeFetch } from '../net.js';
import { ao3CookieHeader } from './ao3session.js';
import type { BookMeta, MetadataCandidate } from '../../../shared/types.js';

/**
 * Recupero "best effort" dei metadati di una fanfic dalla pagina del sito
 * originale (AO3 / FanFiction.net). Funziona solo con link in chiaro:
 * le pagine private o protette non vengono lette.
 *
 * AO3 non espone un'API pubblica: leggiamo la pagina dell'opera con un
 * User-Agent da browser (Cloudflare blocca gli UA "bot") e aggiungiamo
 * `view_adult=true` solo se compare l'interstiziale per i contenuti adulti.
 */

const CACHE_TTL = 10 * 60 * 1000;
const FETCH_TIMEOUT = 15_000;
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const cache = new Map<string, { fetchedAt: number; candidate: MetadataCandidate }>();

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

function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Converte un frammento HTML in testo, mantenendo i paragrafi. */
function htmlToText(input: string): string {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|blockquote|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaContent(html: string, property: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]).trim();
  }
  return '';
}

function classAttribute(input: string): string {
  return input.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase() ?? '';
}

function extractItems(html: string): string[] {
  const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
  if (items.length) return items;
  return stripHtml(html) ? [stripHtml(html)] : [];
}

function parseNumber(value: string): number | null {
  const match = value.match(/\d[\d.,\s]*/);
  if (!match) return null;
  const n = Number.parseInt(match[0].replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

interface ChapterCount {
  current: number | null;
  total: number | null;
  openEnded: boolean;
}

function parseChapterCount(value: string): ChapterCount {
  const fraction = value.match(/(\d+)\s*\/\s*(\d+|\?)/);
  if (fraction) {
    const current = Number.parseInt(fraction[1], 10);
    const total = fraction[2] === '?' ? null : Number.parseInt(fraction[2], 10);
    return {
      current: Number.isFinite(current) ? current : null,
      total: Number.isFinite(total as number) ? total : null,
      openEnded: fraction[2] === '?',
    };
  }
  const single = value.match(/\d+/);
  const current = single ? Number.parseInt(single[0], 10) : null;
  return {
    current: Number.isFinite(current as number) ? current : null,
    total: null,
    openEnded: false,
  };
}

const RATING_MAP: Array<[RegExp, string]> = [
  [/general audiences/i, 'G'],
  [/teen and up/i, 'PG-13'],
  [/\bpg-?13\b/i, 'PG-13'],
  [/\bmature\b/i, 'M'],
  [/\bexplicit\b/i, 'MA'],
  [/not rated/i, 'NR'],
  [/\bma\b/i, 'MA'],
  [/\bk\+/i, 'PG'],
  [/\bk\b/i, 'G'],
  [/\bt\b/i, 'PG-13'],
  [/\bm\b/i, 'M'],
];

function normalizeRating(value: string): string {
  for (const [pattern, code] of RATING_MAP) {
    if (pattern.test(value)) return code;
  }
  return value.trim().slice(0, 12);
}

const LANGUAGE_MAP: Record<string, string> = {
  english: 'en',
  inglese: 'en',
  italian: 'it',
  italiano: 'it',
  french: 'fr',
  francese: 'fr',
  spanish: 'es',
  spagnolo: 'es',
  espanol: 'es',
  espaol: 'es',
  german: 'de',
  tedesco: 'de',
  deutsch: 'de',
  portuguese: 'pt',
  portoghese: 'pt',
  portugues: 'pt',
  portugus: 'pt',
  francais: 'fr',
  franais: 'fr',
  russian: 'ru',
  russo: 'ru',
  japanese: 'ja',
  giapponese: 'ja',
  chinese: 'zh',
  cinese: 'zh',
};

function normalizeLanguage(value: string): string {
  const clean = value.trim();
  const key = clean.toLowerCase().replace(/[^a-z]/g, '');
  if (LANGUAGE_MAP[key]) return LANGUAGE_MAP[key];
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(clean)) return clean.toLowerCase().slice(0, 2);
  return clean.slice(0, 60);
}

function parseSeries(value: string): { name: string; index: number | null } {
  const clean = value
    .replace(/\s+/g, ' ')
    .replace(/\s*Next Work\s*→?\s*$/i, '')
    .trim();
  const match = clean.match(/^Part\s+(\d+)\s+of\s+(.+)$/i);
  if (match) {
    const index = Number.parseInt(match[1], 10);
    return {
      name: match[2].trim().slice(0, 200),
      index: Number.isFinite(index) ? index : null,
    };
  }
  return { name: clean.slice(0, 200), index: null };
}

interface Ao3Pair {
  label: string;
  classes: string[];
  values: string[];
  lang?: string;
}

function extractAo3Pairs(fragment: string): Ao3Pair[] {
  const pairs: Ao3Pair[] = [];
  const pairPattern = /<dt\b([^>]*)>([\s\S]*?)<\/dt>\s*<dd\b([^>]*)>([\s\S]*?)<\/dd>/gi;
  let match: RegExpExecArray | null;
  while ((match = pairPattern.exec(fragment))) {
    const classes = classAttribute(match[3]).split(/\s+/).filter(Boolean);
    const label = stripHtml(match[2]).replace(/:\s*$/, '').trim().toLowerCase();
    const values = extractItems(match[4]);
    const lang = match[3].match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (values.length) pairs.push({ label, classes, values, lang });
  }
  return pairs;
}

function pairValues(
  pairs: Ao3Pair[],
  classNames: string[],
  labels: string[],
): string[] {
  const byClass = pairs.find((pair) => pair.classes.some((name) => classNames.includes(name)));
  if (byClass) return byClass.values;
  return pairs.find((pair) => labels.includes(pair.label))?.values ?? [];
}

function firstPairValue(pairs: Ao3Pair[], classNames: string[], labels: string[]): string {
  return pairValues(pairs, classNames, labels)[0] ?? '';
}

function extractAo3Summary(html: string): string {
  const block = html.match(
    /<div[^>]*class=["'][^"']*summary[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  )?.[1];
  if (!block) return '';
  const quote = block.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1] ?? block;
  return htmlToText(quote);
}

function parseAo3Page(html: string, url: string): MetadataCandidate | null {
  const workId = url.match(/\/works\/(\d+)/i)?.[1] ?? '';
  const canonicalUrl = workId ? `https://archiveofourown.org/works/${workId}` : url;

  const title = stripHtml(
    html.match(/<h2[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? '',
  );
  if (!title) return null;

  const bylineHtml =
    html.match(/<h3[^>]*class=["'][^"']*byline[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '';
  let authors = [...bylineHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
  if (authors.length === 0) {
    const fallback = stripHtml(bylineHtml).replace(/^by\s+/i, '').trim();
    if (fallback) authors = [fallback];
  }

  const description = extractAo3Summary(html);
  const coverUrl = metaContent(html, 'og:image') || null;

  // Il blocco statistiche e' un <dl class="stats"> annidato dentro il <dl>
  // dei metadati. Isolandolo evitiamo che la regex "dt + dd" del blocco
  // esterno si mangi la prima statistica (Published).
  const statsHtml =
    html.match(/<dl\b[^>]*class=["'][^"']*\bstats\b[^"']*["'][^>]*>[\s\S]*?<\/dl>/i)?.[0] ?? '';
  const metaHtml = statsHtml ? html.replace(statsHtml, '') : html;
  const metaPairs = extractAo3Pairs(metaHtml);
  const statsPairs = statsHtml ? extractAo3Pairs(statsHtml) : [];
  const stats = statsPairs.length ? statsPairs : metaPairs;

  const ratingRaw = firstPairValue(metaPairs, ['rating'], ['rating']);
  const warnings = pairValues(metaPairs, ['warning'], ['archive warning', 'archive warnings', 'warnings']);
  const categories = pairValues(metaPairs, ['category'], ['category', 'categories']);
  const fandoms = pairValues(metaPairs, ['fandom'], ['fandom', 'fandoms']);
  const relationships = pairValues(metaPairs, ['relationship'], ['relationship', 'relationships']);
  const characters = pairValues(metaPairs, ['character'], ['character', 'characters']);
  const extraTags = pairValues(metaPairs, ['freeform'], ['additional tags', 'tags']);
  const languagePair = metaPairs.find(
    (pair) => pair.classes.includes('language') || pair.label === 'language',
  );
  const languageRaw = languagePair?.lang || languagePair?.values[0] || '';
  const seriesRaw = firstPairValue(metaPairs, ['series'], ['series']);

  const published = firstPairValue(stats, ['published'], ['published', 'published on']);
  // AO3 usa la stessa classe "status" sia per "Completed" sia per "Updated":
  // distinguiamo dall'etichetta, altrimenti un WIP risulterebbe completo.
  const completed = firstPairValue(stats, [], ['completed', 'completed on']);
  const updated = firstPairValue(stats, [], ['updated', 'updated on', 'last updated']);
  const words = parseNumber(firstPairValue(stats, ['words'], ['words', 'word count']));
  const chapters = parseChapterCount(firstPairValue(stats, ['chapters'], ['chapters', 'chapter count']));

  let status = '';
  if (completed) status = 'Complete';
  else if (updated) status = 'Incomplete';
  else if (chapters.current !== null && chapters.total !== null) {
    status = chapters.total > chapters.current ? 'Incomplete' : 'Complete';
  } else if (chapters.openEnded) {
    status = 'Incomplete';
  }

  const series = parseSeries(seriesRaw);
  const tags = [...new Set([...categories, ...extraTags, ...warnings])].filter(Boolean);

  const fields: Partial<BookMeta> = { kind: 'fanfic' };
  fields.title = title;
  if (authors.length) fields.authors = authors;
  if (description) fields.description = description;
  if (fandoms.length) fields.fandom = fandoms.join(', ');
  if (relationships.length) {
    fields.relationships = relationships;
    fields.ships = relationships;
  }
  if (characters.length) fields.characters = characters;
  if (ratingRaw) fields.fanRating = normalizeRating(ratingRaw);
  if (languageRaw) fields.language = normalizeLanguage(languageRaw);
  if (status) fields.status = status;
  if (tags.length) fields.tags = tags;
  if (published) fields.publishedDate = published;
  if (words !== null) fields.wordCount = words;
  if (chapters.current !== null) fields.chapters = chapters.current;
  if (series.name) fields.series = series.name;
  if (series.index !== null) fields.seriesIndex = series.index;
  if (workId) fields.ao3Url = canonicalUrl;

  return {
    provider: 'ao3',
    label: 'Archive of Our Own',
    url: canonicalUrl,
    coverUrl,
    summary: description.slice(0, 400) || null,
    fields,
  };
}

/** Avanzamento di un'opera AO3 letto dal blocco delle statistiche della pagina. */
export interface Ao3Progress {
  /** Capitoli pubblicati (la X di «X/Y»). */
  chapters: number | null;
  /** Capitoli previsti (la Y), null se «?». */
  total: number | null;
  /** true se AO3 la dichiara completa (campo «Completed» o X == Y). */
  complete: boolean;
  /** Data di «Updated» o «Completed» (AAAA-MM-GG), null se assente. */
  updated: string | null;
  words: number | null;
}

/**
 * Legge capitoli, completezza, data dell'ultimo aggiornamento e parole dalla
 * pagina di un'opera AO3. Restituisce null se la pagina non ha le statistiche
 * (accesso richiesto, pagina d'errore, interstiziale).
 */
export function parseAo3Progress(html: string): Ao3Progress | null {
  const statsHtml =
    html.match(/<dl\b[^>]*class=["'][^"']*\bstats\b[^"']*["'][^>]*>[\s\S]*?<\/dl>/i)?.[0] ?? '';
  if (!statsHtml) return null;
  const stats = extractAo3Pairs(statsHtml);
  const chapterText = firstPairValue(stats, ['chapters'], ['chapters', 'chapter count']);
  if (!chapterText) return null;
  const chapters = parseChapterCount(chapterText);

  // «Completed» e «Updated» hanno la stessa classe `status`: li distingue l'etichetta.
  const completed = firstPairValue(stats, [], ['completed', 'completed on']);
  const updated = firstPairValue(stats, [], ['updated', 'updated on', 'last updated']);
  const complete =
    Boolean(completed) ||
    (chapters.current !== null && chapters.total !== null && chapters.current >= chapters.total);

  return {
    chapters: chapters.current,
    total: chapters.total,
    complete,
    updated: completed || updated || null,
    words: parseNumber(firstPairValue(stats, ['words'], ['words', 'word count'])),
  };
}

function parseLabelPairs(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  const text = decodeEntities(
    html
      .replace(/<\/(p|div|li|tr|dt|dd|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    const match = line.match(/^([A-Za-z][A-Za-z ()\/'.-]{2,30}):\s*(.+)$/);
    if (match) result[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return result;
}

function parseGenericPage(html: string, url: string): MetadataCandidate | null {
  const labels = parseLabelPairs(html);
  const title =
    metaContent(html, 'og:title').replace(
      /\s*(?:\||-)\s*(?:Archive of Our Own|AO3|FanFiction\.net).*$/i,
      '',
    ) ||
    labels['title'] ||
    stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const description =
    metaContent(html, 'og:description') || labels['summary'] || labels['description'] || '';
  const coverUrl = metaContent(html, 'og:image') || null;
  const fandom = labels['fandom'] || labels['fandoms'] || '';
  const rating = labels['rating'] || '';
  const status = labels['status'] || '';
  const language = labels['language'] || '';
  const characters = labels['characters'] || labels['character'] || '';
  const relationships = labels['relationships'] || labels['relationship'] || '';
  const tags = labels['additional tags'] || labels['tags'] || '';
  const words = parseNumber(labels['words'] ?? '');
  const chapters = parseChapterCount(labels['chapters'] ?? '');

  const fields: Partial<BookMeta> = { kind: 'fanfic' };
  if (title) fields.title = title;
  if (description) fields.description = description;
  if (fandom) fields.fandom = fandom;
  if (rating) fields.fanRating = normalizeRating(rating);
  if (status) fields.status = status.slice(0, 24);
  if (language) fields.language = normalizeLanguage(language);
  const characterList = characters.split(/\s*,\s*/).filter(Boolean);
  if (characterList.length) fields.characters = characterList;
  const relationshipList = relationships.split(/\s*,\s*/).filter(Boolean);
  if (relationshipList.length) {
    fields.relationships = relationshipList;
    fields.ships = relationshipList;
  }
  const tagList = tags.split(/\s*,\s*/).filter(Boolean);
  if (tagList.length) fields.tags = tagList;
  if (words !== null) fields.wordCount = words;
  if (chapters.current !== null) fields.chapters = chapters.current;
  if (labels['published']) fields.publishedDate = labels['published'];
  if (labels['series']) fields.series = labels['series'].slice(0, 200);
  if (/archiveofourown\.org/i.test(url)) fields.ao3Url = url;
  else if (/fanfiction\.net/i.test(url)) fields.ffnetUrl = url;

  if (Object.keys(fields).length <= 1) return null;

  return {
    provider: /archiveofourown\.org/i.test(url) ? 'ao3' : 'ffnet',
    label: /archiveofourown\.org/i.test(url) ? 'Archive of Our Own' : 'FanFiction.net',
    url,
    coverUrl,
    summary: description.slice(0, 400) || null,
    fields,
  };
}

function httpErrorMessage(status: number, isAo3: boolean): string {
  const site = isAo3 ? 'AO3' : 'FanFiction.net';
  if (status === 404) return `Opera non trovata su ${site}`;
  if (status === 403) return `${site} ha bloccato la richiesta`;
  if (status === 429) return `${site} ha ricevuto troppe richieste: riprova tra qualche minuto`;
  if (status === 503 || status === 525) return `${site} non raggiungibile (HTTP ${status})`;
  return `${site}: HTTP ${status}`;
}

interface FanficTarget {
  url: string;
  isAo3: boolean;
}

function normalizeTarget(input: string): FanficTarget {
  let raw = input.trim();
  if (!raw) throw new Error('Link fanfic mancante');
  if (/^\d+$/.test(raw)) raw = `https://archiveofourown.org/works/${raw}`;
  else if (/^works\/\d+/i.test(raw)) raw = `https://archiveofourown.org/${raw}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Link fanfic non valido');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Link fanfic non valido');

  const isAo3 = /(^|\.)archiveofourown\.org$/i.test(parsed.hostname);
  const isFfnet = /(^|\.)fanfiction\.net$/i.test(parsed.hostname);
  if (!isAo3 && !isFfnet) {
    throw new Error('Link non supportato: usa AO3 o FanFiction.net');
  }
  parsed.protocol = 'https:';

  if (isAo3) {
    const work = parsed.pathname.match(/\/works\/(\d+)/i);
    if (!work) {
      throw new Error("Link AO3 non valido: manca /works/<id>");
    }
    parsed.pathname = `/works/${work[1]}`;
    parsed.search = '';
    parsed.hash = '';
  }

  return { url: parsed.toString(), isAo3 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestOptions {
  /** Timeout della singola richiesta (default 15 s). */
  timeoutMs?: number;
  /** Numero di tentativi complessivi (default 3). */
  attempts?: number;
  /** Riprova anche quando la richiesta va in timeout. */
  retryTimeouts?: boolean;
  /** Pausa base fra i tentativi (default 250 ms). */
  retryDelayMs?: number;
  /** Scadenza complessiva (epoch ms): nessun tentativo può superarla. */
  deadline?: number;
}

const RETRYABLE_STATUS = new Set([503, 520, 521, 522, 524, 525]);

function isTimeoutError(error: unknown): boolean {
  const name = (error as Error)?.name ?? '';
  const message = (error as Error)?.message ?? '';
  return /timeout|aborted/i.test(name) || /timeout|aborted/i.test(message);
}

async function requestHtml(
  url: string,
  headers: Record<string, string>,
  isAo3: boolean,
  options: RequestOptions = {},
): Promise<Response> {
  const site = isAo3 ? 'AO3' : 'FanFiction.net';
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? FETCH_TIMEOUT);
  const retryDelay = Math.max(0, options.retryDelayMs ?? 250);

  // Cloudflare su AO3 restituisce 525/503 a intermittenza: tentativi
  // ravvicinati (senza backoff lungo) superano spesso l'errore.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = options.deadline ? options.deadline - Date.now() : timeoutMs;
    if (remaining < 500) throw new Error(`${site} non risponde (timeout)`);

    let response: Response;
    try {
      response = await safeFetch(url, {
        redirect: 'follow',
        headers,
        signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
      });
    } catch (error) {
      const timeout = isTimeoutError(error);
      if (timeout && options.retryTimeouts && attempt < attempts - 1) {
        await sleep(retryDelay + attempt * 200);
        continue;
      }
      if (timeout) throw new Error(`${site} non risponde (timeout)`);
      throw new Error(`${site} non raggiungibile: ${(error as Error).message}`);
    }
    if (response.ok) return response;
    if (RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
      await response.text().catch(() => undefined);
      await sleep(retryDelay + attempt * 200);
      continue;
    }
    throw new Error(httpErrorMessage(response.status, isAo3));
  }
  throw new Error(httpErrorMessage(525, isAo3));
}

async function fetchHtml(
  target: FanficTarget,
  options: RequestOptions = {},
): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
  };
  // Con l'accesso ad AO3 le opere riservate agli utenti registrati sono leggibili.
  const cookie = target.isAo3 ? ao3CookieHeader() : null;
  if (cookie) headers.Cookie = cookie;

  // Su AO3 il parametro `view_adult=true` a volte fa rispondere Cloudflare
  // con 525/timeout: proviamo prima l'URL normale e lo aggiungiamo solo se
  // compare davvero l'interstiziale per i contenuti adulti.
  let response = await requestHtml(target.url, headers, target.isAo3, options);
  let html = await response.text();

  if (
    target.isAo3 &&
    /This work could have adult content/i.test(html) &&
    !/work meta group/i.test(html)
  ) {
    const retryUrl = new URL(target.url);
    retryUrl.searchParams.set('view_adult', 'true');
    response = await requestHtml(retryUrl.toString(), headers, target.isAo3, options);
    html = await response.text();
    if (/This work could have adult content/i.test(html) && !/work meta group/i.test(html)) {
      throw new Error('AO3 richiede la conferma per i contenuti adulti');
    }
  }

  return html;
}

/** Scarica una pagina AO3 (opera o serie) con le stesse cautele delle opere. */
export async function fetchAo3Html(
  url: string,
  options: RequestOptions = {},
): Promise<string> {
  return fetchHtml({ url, isAo3: true }, options);
}

export async function fetchFanficPage(input: string): Promise<MetadataCandidate | null> {
  const target = normalizeTarget(input);
  const cached = cache.get(target.url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.candidate;

  const html = await fetchHtml(target);

  if (target.isAo3 && /This work could have adult content/i.test(html) && !/work meta group/i.test(html)) {
    throw new Error('AO3 richiede la conferma per i contenuti adulti');
  }

  const candidate = target.isAo3
    ? parseAo3Page(html, target.url)
    : parseGenericPage(html, target.url);

  if (!candidate) return null;
  cache.set(target.url, { fetchedAt: Date.now(), candidate });
  return candidate;
}
