import AdmZip from 'adm-zip';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeLanguage,
  parseAo3Details,
  parseAo3Progress,
  type Ao3Details,
  type Ao3Progress,
} from './providers/fanfic.js';
import { EPUB_CONTAINER_XML, EPUB_CSS, coverXhtml, renderCover } from './efp.js';
import {
  blocksToXhtml,
  decodeHtmlEntities,
  escapeXml,
  htmlToBlocks,
  paragraphText,
  type EfpParagraph,
} from './efpHtml.js';
import {
  findDuplicate,
  findDuplicateByMeta,
  getBookMeta,
  importPath,
  makeWorkDir,
  prepareImport,
  sanitizeFolderName,
  type DuplicateMatch,
} from './library.js';
import { syncAppleBooksForBooks } from './appleBooks.js';
import type { BookMeta } from '../../shared/types.js';

/**
 * Import di una fanfic AO3 dal Web Archive (web.archive.org): serve per le
 * opere rimosse da AO3. Si prova prima l'EPUB ufficiale archiviato; se non c'e'
 * si ricostruisce la storia dalle pagine archiviate, ma solo se ci sono tutti i
 * capitoli pubblicati (la X di «X/Y»).
 *
 * Si parla solo con web.archive.org (host fisso): dall'input dell'utente si
 * prendono l'id dell'opera e l'eventuale data della copia, mai URL interi.
 */

const ARCHIVE_ORIGIN = 'https://web.archive.org';
const REQUEST_TIMEOUT = 60_000;
/**
 * Il Wayback blocca con 429 («suspected abusive bot traffic») gli User-Agent da
 * browser finti come quello usato per AO3: con uno onesto risponde regolarmente.
 */
const WAYBACK_USER_AGENT = 'Mozilla/5.0 (compatible; books-editor/1.0)';
/** Il Wayback limita le richieste: una pausa minima fra l'una e l'altra. */
const MIN_GAP_MS = 1000;
const RETRY_DELAYS = [3000, 8000];
const MAX_REDIRECTS = 6;
const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const MAX_EPUB_BYTES = 80 * 1024 * 1024;
/** Tetto di sicurezza alle richieste di una singola importazione. */
const MAX_REQUESTS = 900;
/** Quante copie provare per la pagina principale e per ogni capitolo. */
const MAX_BASE_TRIES = 8;
const MAX_FULL_TRIES = 3;
const MAX_CHAPTER_TRIES = 6;

/* ----------------------------------------------------------------- input -- */

export interface WaybackInput {
  workId: string;
  /** Data della copia richiesta (1-14 cifre AAAAMMGGhhmmss), null = la piu' recente. */
  timestamp: string | null;
  chapterId?: string;
}

const AO3_HOST = '(?:www\\.)?(?:archiveofourown\\.(?:org|com|net|gay)|ao3\\.org)';
const NOT_RECOGNIZED =
  'Link non riconosciuto: incolla il link del Web Archive di un\'opera AO3 (…/works/<numero>), un link AO3 normale oppure il numero dell\'opera.';

/** Riconosce l'opera AO3 (e la data della copia) in un link Wayback, in un link AO3 o in un id. */
export function parseWaybackInput(input: string): WaybackInput {
  const value = (input ?? '').trim();
  if (!value) throw new Error('Incolla un link del Web Archive o di AO3, oppure il numero dell\'opera.');

  if (/^\d+$/.test(value)) return { workId: normalizeId(value), timestamp: null };

  let timestamp: string | null = null;
  let original = value;
  const wayback = value.match(
    /^(?:https?:\/*)?(?:web\.)?archive\.org\/web\/(\d{1,14}|\*)(?:[a-z]{2}_)*\/(.+)$/i,
  );
  if (wayback) {
    timestamp = /^\d+$/.test(wayback[1]) ? wayback[1] : null;
    original = wayback[2];
  } else if (/archive\.org\//i.test(value) && !new RegExp(`^(?:https?:\\/*)?${AO3_HOST}`, 'i').test(value)) {
    // Un link di archive.org che non e' una copia del Wayback.
    throw new Error(NOT_RECOGNIZED);
  }

  const work = original.match(
    new RegExp(
      `^(?:https?:\\/*)?${AO3_HOST}(?::\\d+)?\\/works\\/0*(\\d+)(?:\\/chapters\\/0*(\\d+))?(?:[/?#]|$)`,
      'i',
    ),
  );
  if (work) {
    return {
      workId: normalizeId(work[1]),
      timestamp,
      ...(work[2] ? { chapterId: normalizeId(work[2]) } : {}),
    };
  }
  const bare = original.match(/^works\/0*(\d+)(?:[/?#]|$)/i);
  if (bare) return { workId: normalizeId(bare[1]), timestamp };
  throw new Error(NOT_RECOGNIZED);
}

function normalizeId(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '');
}

/* ------------------------------------------------------------------ rete -- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;

/** Pausa fra una richiesta e la successiva. */
async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + MIN_GAP_MS);
  if (wait > 0) await sleep(wait);
}

interface ArchiveResponse {
  /** Data (14 cifre) della copia effettivamente servita, dall'URL finale. */
  timestamp: string | null;
  body: Buffer;
}

class RetryableError extends Error {
  /** Attesa minima prima del prossimo tentativo (il Wayback con 429 chiede pause lunghe). */
  constructor(message: string, readonly waitMs = 0) {
    super(message);
  }
}

interface Counter {
  requests: number;
}

/**
 * GET su web.archive.org (solo percorso: l'host e' fisso). Segue a mano i
 * redirect, restando sullo stesso host. Restituisce null se la copia non
 * esiste (404). Riprova su errori di rete, 429, 5xx e sulla pagina
 * «Temporarily Offline».
 */
async function archiveGet(
  pathAndQuery: string,
  counter: Counter,
  options: { maxBytes?: number; attempts?: number } = {},
): Promise<ArchiveResponse | null> {
  const attempts = Math.max(1, options.attempts ?? RETRY_DELAYS.length + 1);
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  let lastError: Error = new Error('Il Web Archive non risponde: riprova fra qualche minuto.');
  let extraWait = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(Math.max(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)], extraWait));
    }
    extraWait = 0;
    try {
      let url = new URL(pathAndQuery, ARCHIVE_ORIGIN);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (url.protocol !== 'https:' || url.hostname !== 'web.archive.org') {
          throw new Error('Il Web Archive ha risposto con un reindirizzamento non valido.');
        }
        if (counter.requests >= MAX_REQUESTS) {
          throw new Error('Troppe richieste al Web Archive per questa opera: importazione interrotta.');
        }
        counter.requests += 1;
        await pace();
        const response = await fetch(url, {
          redirect: 'manual',
          headers: {
            'User-Agent': WAYBACK_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location) throw new Error('Il Web Archive ha risposto con un reindirizzamento non valido.');
          url = new URL(location, url);
          continue;
        }
        if (response.status === 404 || response.status === 410) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          const retryAfter = Number(response.headers.get('retry-after') ?? 0) * 1000;
          throw new RetryableError(
            `Il Web Archive non e' disponibile (HTTP ${response.status}): riprova fra qualche minuto.`,
            response.status === 429 ? Math.min(Math.max(retryAfter, 20_000), 60_000) : 0,
          );
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`Il Web Archive ha risposto HTTP ${response.status}.`);
        }
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error('Il file del Web Archive e\' troppo grande.');
        }
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > maxBytes) throw new Error('Il file del Web Archive e\' troppo grande.');
        // Quando e' in manutenzione risponde con una pagina HTML (anche con 200).
        if (body.length < 30_000 && /Temporarily Offline/i.test(body.toString('utf8', 0, 4000))) {
          throw new RetryableError('Il Web Archive e\' temporaneamente offline: riprova fra qualche minuto.');
        }
        return { timestamp: url.pathname.match(/^\/web\/(\d{14})/)?.[1] ?? null, body };
      }
      throw new Error('Il Web Archive ha risposto con troppi reindirizzamenti.');
    } catch (error) {
      const err = error as Error;
      const network = err instanceof TypeError || /timeout|aborted/i.test(`${err.name} ${err.message}`);
      if (err instanceof RetryableError) {
        lastError = err;
        extraWait = err.waitMs;
        continue;
      }
      if (network) {
        lastError = new Error('Il Web Archive non risponde: riprova fra qualche minuto.');
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------- snapshot -- */

type CandidateKind = 'work' | 'chapter' | 'navigate';

interface Candidate {
  /** Data (14 cifre) della copia; null = si lascia scegliere al Wayback la piu' vicina. */
  timestamp: string | null;
  /** URL originale ricostruito (mai preso tale e quale dall'input). */
  url: string;
  kind: CandidateKind;
  full: boolean;
  comments: boolean;
  chapterId?: string;
}

interface Page {
  timestamp: string;
  html: string;
  candidate: Candidate;
}

interface Context {
  workId: string;
  /** Data richiesta dall'utente, null = piu' recente. */
  target: string | null;
  counter: Counter;
  cache: Map<string, Page | null>;
}

function parseTimestamp(ts: string): number {
  const digits = ts.replace(/\D/g, '');
  const part = (from: number, to: number, fallback: number) => {
    const piece = digits.slice(from, to);
    return piece ? Number(piece) : fallback;
  };
  return Date.UTC(
    part(0, 4, 2000),
    Math.max(1, part(4, 6, 1)) - 1,
    Math.max(1, part(6, 8, 1)),
    part(8, 10, 0),
    part(10, 12, 0),
    part(12, 14, 0),
  );
}

/** Ordina le copie per vicinanza alla data indicata (o dalla piu' recente se null). */
function sortCandidates(list: Candidate[], target: string | null): Candidate[] {
  const goal = target ? parseTimestamp(target) : null;
  const distance = (candidate: Candidate): number => {
    if (!candidate.timestamp) return Number.MAX_SAFE_INTEGER;
    const time = parseTimestamp(candidate.timestamp);
    return goal === null ? -time : Math.abs(time - goal);
  };
  return [...list].sort((a, b) => {
    // Le pagine con i commenti vengono per ultime: sono enormi.
    if (a.comments !== b.comments) return a.comments ? 1 : -1;
    return distance(a) - distance(b);
  });
}

function workUrl(workId: string, suffix = ''): string {
  return `http://archiveofourown.org/works/${workId}${suffix}`;
}

/**
 * Elenco delle copie dell'opera dal CDX (una sola query con prefisso). Restituisce
 * null se il CDX non risponde: si ripiega allora sulle varianti fisse.
 */
async function listCdx(ctx: Context): Promise<Candidate[] | null> {
  const query =
    `/cdx/search/cdx?url=archiveofourown.org/works/${ctx.workId}&matchType=prefix` +
    '&filter=statuscode:200&fl=timestamp,original&output=json&limit=1000';
  let rows: unknown;
  try {
    const response = await archiveGet(query, ctx.counter, { attempts: 2 });
    if (!response) return [];
    rows = JSON.parse(response.body.toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  // Solo /works/<id> seguito da fine, /chapters/<n>, /navigate, ? o #: l'ID e' un
  // prefisso e il CDX restituisce anche altre opere (8625940...) e pagine laterali.
  const pattern = new RegExp(
    `^https?:\\/\\/${AO3_HOST}(?::\\d+)?\\/works\\/${ctx.workId}(?:\\/chapters\\/(\\d+)|(\\/navigate))?\\/?(?:\\?([^#]*))?(?:#.*)?$`,
    'i',
  );
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row)) continue;
    const timestamp = String(row[0] ?? '');
    const original = String(row[1] ?? '');
    if (!/^\d{14}$/.test(timestamp)) continue;
    const match = original.match(pattern);
    if (!match) continue;
    let rawQuery = (match[3] ?? '').replace(/\/+$/, '');
    if (!/^[\w=&%.+-]*$/.test(rawQuery)) continue;
    const comments = /(^|&)(show_comments|page|view_commit)=/i.test(rawQuery) || /(^|&)add_comment/i.test(rawQuery);
    const full = /(^|&)view_full_work=true/i.test(rawQuery);
    if (/(^|&)view_full_work=false/i.test(rawQuery)) rawQuery = '';
    const suffix = match[1] ? `/chapters/${match[1]}` : match[2] ? '/navigate' : '';
    const url = workUrl(ctx.workId, `${suffix}${rawQuery ? `?${rawQuery}` : ''}`);
    const key = `${timestamp}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      timestamp,
      url,
      kind: match[1] ? 'chapter' : match[2] ? 'navigate' : 'work',
      full,
      comments,
      ...(match[1] ? { chapterId: match[1] } : {}),
    });
  }
  return result;
}

/** Varianti fisse da provare col redirect del Wayback quando il CDX non risponde. */
function probeCandidates(ctx: Context): Candidate[] {
  const variants: Array<[string, CandidateKind, boolean]> = [
    ['?view_full_work=true', 'work', true],
    ['?view_adult=true&view_full_work=true', 'work', true],
    ['?view_full_work=true&view_adult=true', 'work', true],
    ['', 'work', false],
    ['?view_adult=true', 'work', false],
    ['/navigate', 'navigate', false],
  ];
  return variants.map(([suffix, kind, full]) => ({
    timestamp: null,
    url: workUrl(ctx.workId, suffix),
    kind,
    full,
    comments: false,
  }));
}

/** Scarica una copia (null se non esiste). La stessa copia non si riscarica due volte. */
async function fetchCandidate(ctx: Context, candidate: Candidate, nearTo?: string | null): Promise<Page | null> {
  const requested = candidate.timestamp ?? nearTo ?? ctx.target ?? '2';
  const key = `${requested}|${candidate.url}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key) ?? null;
  const response = await archiveGet(`/web/${requested}id_/${candidate.url}`, ctx.counter);
  const page: Page | null = response
    ? {
        timestamp: response.timestamp ?? candidate.timestamp ?? requested.padEnd(14, '0'),
        html: response.body.toString('utf8'),
        candidate,
      }
    : null;
  ctx.cache.set(key, page);
  return page;
}

/* ---------------------------------------------------------- lettura HTML -- */

/** Una pagina e' utile se ha titolo e statistiche: niente interstiziali, login o pagine d'errore. */
function readWorkPage(html: string): { details: Ao3Details; progress: Ao3Progress } | null {
  if (!/id=["']chapters["']/i.test(html)) return null;
  const progress = parseAo3Progress(html);
  if (!progress || progress.chapters === null) return null;
  const details = parseAo3Details(html);
  if (!details) return null;
  return { details, progress };
}

function classTokens(attributes: string): string[] {
  return (attributes.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

interface Region {
  start: number;
  end: number;
  inner: string;
  attributes: string;
}

/** Il <div> che inizia in `start`, con il suo contenuto (conta i <div> annidati). */
function balancedDiv(html: string, start: number): Region | null {
  const open = html.slice(start).match(/^<div\b([^>]*)>/i);
  if (!open) return null;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) {
      return {
        start,
        end: match.index + match[0].length,
        inner: html.slice(start + open[0].length, match.index),
        attributes: open[1],
      };
    }
  }
  return null;
}

/** Tutti i <div> (non annidati fra loro) per cui `accept` e' vero. */
function findDivs(html: string, accept: (attributes: string, tokens: string[]) => boolean): Region[] {
  const result: Region[] = [];
  const opening = /<div\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    if (!accept(match[1], classTokens(match[1]))) continue;
    const region = balancedDiv(html, match.index);
    if (!region) continue;
    result.push(region);
    opening.lastIndex = region.end;
  }
  return result;
}

function plainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/[ \s]+/g, ' ')
    .trim();
}

/** Contenuto del <blockquote class="userstuff"> di un modulo (riassunto o note). */
function quoteInner(moduleHtml: string): string {
  const open = moduleHtml.match(/<blockquote\b[^>]*>/i);
  if (!open || open.index === undefined) return '';
  const from = open.index + open[0].length;
  const to = moduleHtml.toLowerCase().lastIndexOf('</blockquote>');
  return (to >= from ? moduleHtml.slice(from, to) : moduleHtml.slice(from))
    // «(See the end of the work for more notes)»
    .replace(/<p\b[^>]*class=["'][^"']*\bjump\b[^"']*["'][^>]*>[\s\S]*?<\/p>/gi, '')
    .trim();
}

interface RawChapter {
  id?: string;
  /** Titolo come scritto nella pagina («Chapter 3: Nome», «Nome» o vuoto). */
  title: string;
  heading: string;
  summary: string;
  notes: string;
  body: string;
  endNotes: string;
}

function parseChapterBlock(block: string): RawChapter {
  // Il testo e' il primo <div class="userstuff ...">: i moduli di riassunto e note usano <blockquote>.
  const bodyRegion = findDivs(block, (_, tokens) => tokens.includes('userstuff'))[0];
  const rest = bodyRegion ? block.slice(0, bodyRegion.start) + block.slice(bodyRegion.end) : block;
  const body = (bodyRegion?.inner ?? '').replace(
    /<h3\b[^>]*class=["'][^"']*\blandmark\b[^"']*["'][^>]*>[\s\S]*?<\/h3>/gi,
    '',
  );

  const titleHtml =
    block.match(/<h3\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '';
  const heading = plainText(
    block.match(/<h2\b[^>]*class=["'][^"']*\bheading\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? '',
  );

  const modules = findDivs(rest, (_, tokens) => tokens.includes('module'));
  const pick = (accept: (tokens: string[]) => boolean): string => {
    const found = modules.find((region) => accept(classTokens(region.attributes)));
    return found ? quoteInner(found.inner) : '';
  };

  return {
    id: titleHtml.match(/\/chapters\/(\d+)/)?.[1],
    title: plainText(titleHtml),
    heading: /^chapter\s+\d+/i.test(heading) ? heading : '',
    summary: pick((tokens) => tokens.includes('summary')),
    notes: pick((tokens) => tokens.includes('notes') && !tokens.includes('end')),
    body,
    endNotes: pick((tokens) => tokens.includes('notes') && tokens.includes('end')),
  };
}

/** Capitoli presenti in una pagina: tutti i div.chapter, oppure il solo testo di una one-shot. */
function extractChapters(html: string): { chapters: RawChapter[]; workStart: string; workEnd: string } {
  const container = findDivs(html, (attributes) => /\bid\s*=\s*["']chapters["']/i.test(attributes))[0];
  if (!container) return { chapters: [], workStart: '', workEnd: '' };

  const blocks = findDivs(
    container.inner,
    (_, tokens) =>
      tokens.includes('chapter') &&
      !tokens.includes('preface') &&
      !tokens.includes('group') &&
      !tokens.includes('meta'),
  );
  const chapters = (blocks.length ? blocks.map((block) => block.inner) : [container.inner]).map(
    parseChapterBlock,
  );

  // Note dell'opera: prima dei capitoli (inizio) e dopo (fine).
  const before = html.slice(0, container.start);
  const after = html.slice(container.end);
  const notesBefore = findDivs(
    before,
    (_, tokens) => tokens.includes('module') && tokens.includes('notes') && !tokens.includes('end'),
  )[0];
  const notesAfter = findDivs(
    after,
    (_, tokens) => tokens.includes('module') && tokens.includes('notes') && tokens.includes('end'),
  )[0];
  return {
    chapters,
    workStart: notesBefore ? quoteInner(notesBefore.inner) : '',
    workEnd: notesAfter ? quoteInner(notesAfter.inner) : '',
  };
}

function hasText(html: string): boolean {
  return htmlToBlocks(html).some((paragraph) => paragraphText(paragraph).trim().length > 0);
}

interface IndexEntry {
  id: string;
  title: string;
}

/** Elenco dei capitoli dal menu «selected_id» delle pagine dell'opera. */
function chapterIndexFromSelect(html: string): IndexEntry[] {
  const select = html.match(/<select\b[^>]*id=["']selected_id["'][^>]*>([\s\S]*?)<\/select>/i)?.[1];
  if (!select) return [];
  return [...select.matchAll(/<option\b[^>]*value=["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/gi)].map(
    (match) => ({ id: match[1], title: plainText(match[2]).replace(/^\d+\.\s*/, '') }),
  );
}

/** Elenco dei capitoli dalla pagina /navigate. */
function chapterIndexFromNavigate(html: string): IndexEntry[] {
  const list = html.match(/<ol\b[^>]*class=["'][^"']*\bchapter\b[^"']*["'][^>]*>([\s\S]*?)<\/ol>/i)?.[1];
  if (!list) return [];
  return [...list.matchAll(/<a\b[^>]*href=["'][^"']*\/chapters\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)].map(
    (match) => ({ id: match[1], title: plainText(match[2]).replace(/^\d+\.\s*/, '') }),
  );
}

/* ------------------------------------------------------------- risoluzione -- */

interface Resolved {
  kind: 'epub' | 'html';
  snapshot: string;
  details: Ao3Details;
  progress: Ao3Progress;
  epub?: Buffer;
  chapters?: RawChapter[];
  workStart?: string;
  workEnd?: string;
}

class MissingChaptersError extends Error {}

/** «3», «3 e 5», «3, 5 e 8». */
function listNumbers(numbers: number[]): string {
  if (numbers.length === 1) return String(numbers[0]);
  return `${numbers.slice(0, -1).join(', ')} e ${numbers[numbers.length - 1]}`;
}

/** Prova l'EPUB ufficiale archiviato: valido solo se e' davvero un EPUB e non e' piu' vecchio della pagina. */
async function tryOfficialEpub(ctx: Context, page: Page, published: number): Promise<Buffer | null> {
  const href = [...page.html.matchAll(/href=["']([^"']*\/downloads\/[^"']*\.epub[^"']*)["']/gi)]
    .map((match) => decodeHtmlEntities(match[1]))[0];
  if (!href) return null;
  let parsed: URL;
  try {
    parsed = new URL(href, 'http://archiveofourown.org/');
  } catch {
    return null;
  }
  if (!/(^|\.)archiveofourown\.org$/i.test(parsed.hostname)) return null;
  if (!/^\/downloads\/[^\s"'<>]+\.epub$/i.test(parsed.pathname)) return null;
  const host = /^download\./i.test(parsed.hostname) ? 'download.archiveofourown.org' : 'archiveofourown.org';

  const variants = [`${parsed.pathname}${parsed.search}`];
  if (parsed.search) variants.push(parsed.pathname);
  for (const variant of variants) {
    try {
      const response = await archiveGet(`/web/${page.timestamp}id_/http://${host}${variant}`, ctx.counter, {
        maxBytes: MAX_EPUB_BYTES,
        attempts: 2,
      });
      if (!response || !isEpub(response.body)) continue;
      // Un EPUB di quando l'opera aveva meno capitoli non basta: si ricostruisce dalle pagine.
      const count = epubPublishedChapters(response.body);
      if (count !== null && count < published) continue;
      return response.body;
    } catch {
      // Qualsiasi problema con l'EPUB non blocca: si ricostruisce dall'HTML.
    }
  }
  return null;
}

function isEpub(buffer: Buffer): boolean {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  try {
    const entry = new AdmZip(buffer).getEntry('mimetype');
    return entry?.getData().toString('utf8').trim() === 'application/epub+zip';
  } catch {
    return false;
  }
}

/** La X di «Chapters: X/Y» nella prefazione di un EPUB di AO3, se si trova. */
function epubPublishedChapters(buffer: Buffer): number | null {
  try {
    const entries = new AdmZip(buffer)
      .getEntries()
      .filter((entry) => /\.x?html?$/i.test(entry.entryName))
      .slice(0, 4);
    for (const entry of entries) {
      const text = entry.getData().toString('utf8');
      const match = text.match(/Chapters:(?:\s|<[^>]+>)*(\d+)\s*\//i);
      if (match) return Number(match[1]);
    }
  } catch {
    // EPUB illeggibile: ci pensa la verifica successiva.
  }
  return null;
}

/** Cerca la pagina di un capitolo fra le copie del CDX e, in ultimo, col redirect del Wayback. */
async function fetchChapterPage(
  ctx: Context,
  cdx: Candidate[] | null,
  chapterId: string,
  nearTo: string,
): Promise<RawChapter | null> {
  const known = cdx
    ? sortCandidates(
        cdx.filter((candidate) => candidate.kind === 'chapter' && candidate.chapterId === chapterId),
        nearTo,
      )
    : [];
  const probes: Candidate[] = ['', '?view_adult=true'].map((query) => ({
    timestamp: null,
    url: workUrl(ctx.workId, `/chapters/${chapterId}${query}`),
    kind: 'chapter',
    full: false,
    comments: false,
    chapterId,
  }));
  const tries = [...known.slice(0, 4), ...probes].slice(0, MAX_CHAPTER_TRIES);
  for (const candidate of tries) {
    const page = await fetchCandidate(ctx, candidate, nearTo);
    if (!page || !readWorkPage(page.html)) continue;
    const chapter = extractChapters(page.html).chapters[0];
    if (chapter && hasText(chapter.body)) return { ...chapter, id: chapter.id ?? chapterId };
  }
  return null;
}

/** Trova nel Web Archive la copia dell'opera e tutto il necessario per importarla. */
async function resolveWork(ctx: Context): Promise<Resolved> {
  const cdx = await listCdx(ctx);
  const workCandidates = cdx
    ? sortCandidates(cdx.filter((candidate) => candidate.kind === 'work'), ctx.target)
    : probeCandidates(ctx).filter((candidate) => candidate.kind === 'work');

  // 1) Prima copia leggibile della pagina dell'opera.
  let base: (Page & { details: Ao3Details; progress: Ao3Progress }) | null = null;
  for (const candidate of workCandidates.slice(0, MAX_BASE_TRIES)) {
    const page = await fetchCandidate(ctx, candidate);
    const read = page ? readWorkPage(page.html) : null;
    if (page && read) {
      base = { ...page, ...read };
      break;
    }
  }
  if (!base) throw new Error('Il Web Archive non ha copie leggibili di questa opera.');

  // 2) EPUB ufficiale, se e' stato archiviato.
  const published = base.progress.chapters ?? 1;
  const epub = await tryOfficialEpub(ctx, base, published);
  if (epub) {
    return { kind: 'epub', snapshot: base.timestamp, details: base.details, progress: base.progress, epub };
  }

  // 3) Ricostruzione dall'HTML.
  let current = base;
  let extracted = extractChapters(current.html);

  if (published > 1 && extracted.chapters.length < published) {
    // Meglio una copia con tutta l'opera in una sola pagina («view_full_work»).
    const fullCandidates = (cdx
      ? sortCandidates(
          cdx.filter((candidate) => candidate.kind === 'work' && candidate.full),
          base.timestamp,
        )
      : probeCandidates(ctx).filter((candidate) => candidate.full)
    ).slice(0, MAX_FULL_TRIES);
    for (const candidate of fullCandidates) {
      const page = await fetchCandidate(ctx, candidate, base.timestamp);
      const read = page ? readWorkPage(page.html) : null;
      if (!page || !read) continue;
      const chapters = extractChapters(page.html);
      const count = read.progress.chapters ?? 0;
      if (count >= published && chapters.chapters.length === count && chapters.chapters.every((c) => hasText(c.body))) {
        current = { ...page, ...read };
        extracted = chapters;
        break;
      }
    }
  }

  const total = current.progress.chapters ?? 1;
  let chapters = extracted.chapters.slice(0, total);

  if (chapters.length < total) {
    // Capitolo per capitolo: la pagina dell'opera ha il primo, gli altri sono /chapters/<id>.
    let index = chapterIndexFromSelect(current.html);
    if (index.length < total) {
      const navigate = cdx
        ? sortCandidates(
            cdx.filter((candidate) => candidate.kind === 'navigate'),
            current.timestamp,
          )
        : probeCandidates(ctx).filter((candidate) => candidate.kind === 'navigate');
      for (const candidate of navigate.slice(0, 2)) {
        const page = await fetchCandidate(ctx, candidate, current.timestamp);
        const found = page ? chapterIndexFromNavigate(page.html) : [];
        if (found.length >= total) {
          index = found;
          break;
        }
      }
    }
    if (index.length < total) {
      throw new Error(
        'Nel Web Archive manca l\'indice dei capitoli di questa opera: la storia non si può ricostruire per intero.',
      );
    }

    const built: Array<RawChapter | null> = [];
    const missing: number[] = [];
    for (let number = 1; number <= total; number += 1) {
      const fromPage = extracted.chapters[number - 1];
      if (fromPage && hasText(fromPage.body)) {
        built.push(fromPage);
        continue;
      }
      const chapter = await fetchChapterPage(ctx, cdx, index[number - 1].id, current.timestamp);
      built.push(chapter ? { ...chapter, title: chapter.title || index[number - 1].title } : null);
      if (!chapter) missing.push(number);
    }
    if (missing.length) {
      throw new MissingChaptersError(
        `Nel Web Archive mancano i capitoli ${listNumbers(missing)} su ${total}: la storia non si può ricostruire per intero.`,
      );
    }
    chapters = built as RawChapter[];
  } else if (!chapters.every((chapter) => hasText(chapter.body))) {
    const missing = chapters.flatMap((chapter, i) => (hasText(chapter.body) ? [] : [i + 1]));
    throw new MissingChaptersError(
      `Nel Web Archive mancano i capitoli ${listNumbers(missing)} su ${total}: la storia non si può ricostruire per intero.`,
    );
  }

  return {
    kind: 'html',
    snapshot: current.timestamp,
    details: current.details,
    progress: current.progress,
    chapters,
    workStart: extracted.workStart,
    workEnd: extracted.workEnd,
  };
}

/* ------------------------------------------------------------------ EPUB -- */

interface BuiltChapter {
  number: number;
  title: string;
  summary: EfpParagraph[];
  notes: EfpParagraph[];
  paragraphs: EfpParagraph[];
  endNotes: EfpParagraph[];
}

/** «Chapter 3: Nome», «Chapter 3» oppure, per un'opera in un solo capitolo, il titolo dell'opera. */
function chapterTitle(raw: RawChapter, number: number, total: number, workTitle: string): string {
  const title = raw.title.replace(/\s+/g, ' ').trim();
  if (/^chapter\s+\d+/i.test(title)) return title;
  if (title) return `${raw.heading || `Chapter ${number}`}: ${title}`;
  if (raw.heading) return raw.heading;
  return total === 1 ? workTitle : `Chapter ${number}`;
}

function buildChapters(chapters: RawChapter[], workTitle: string): BuiltChapter[] {
  return chapters.map((raw, i) => ({
    number: i + 1,
    title: chapterTitle(raw, i + 1, chapters.length, workTitle),
    summary: raw.summary ? htmlToBlocks(raw.summary) : [],
    notes: raw.notes ? htmlToBlocks(raw.notes) : [],
    paragraphs: htmlToBlocks(raw.body),
    endNotes: raw.endNotes ? htmlToBlocks(raw.endNotes) : [],
  }));
}

/** Nome e posizione della serie: «Part 2 of Nome» (moderno) o «Part 1 of the Nome series» (2016). */
function seriesOf(details: Ao3Details): { name: string; index: number | null } | null {
  if (!details.seriesRaw && !details.seriesHtml) return null;
  const index = details.seriesHtml.match(/Part\s*(?:<[^>]*>)*\s*(\d+)/i)?.[1];
  const link = details.seriesHtml.match(/<a\b[^>]*href=["'][^"']*\/series\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1];
  let name = link ? plainText(link) : '';
  if (!name) {
    name = details.seriesRaw
      .replace(/\s*(?:Previous Work\s*←?|Next Work\s*→?)\s*/gi, ' ')
      .replace(/^Part\s+\d+\s+of\s+(?:the\s+)?/i, '')
      .replace(/\s+series\s*$/i, '')
      .trim();
  }
  if (!name) return null;
  return { name, index: index ? Number(index) : null };
}

/** «English» da «en» (la pagina a volte ha solo il codice nell'attributo lang). */
function languageName(value: string): string {
  if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(value.trim())) return value;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(value.trim()) ?? value;
  } catch {
    return value;
  }
}

/** «9 maggio 2016» dalla data della copia (14 cifre). */
export function formatSnapshotDate(timestamp: string): string {
  return new Date(parseTimestamp(timestamp)).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const EXTRA_CSS = `.preface p { text-align: left; margin: 0 0 0.4em; }
.preface .byline { font-style: italic; }
.notes { margin: 0 0 1.4em; padding-left: 0.8em; border-left: 3px solid #bbb; font-size: 0.9em; }
.notes p.label { font-weight: bold; margin-bottom: 0.3em; }
.end-notes { margin-top: 1.6em; }
`;

function xhtmlDocument(title: string, language: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}" lang="${language}">
  <head>
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
${body}
  </body>
</html>`;
}

function notesXhtml(label: string, paragraphs: EfpParagraph[], extraClass = ''): string {
  if (!paragraphs.length) return '';
  return `      <div class="notes${extraClass}">
        <p class="label">${escapeXml(label)}</p>
${blocksToXhtml(paragraphs, '        ')}
      </div>
`;
}

function chapterXhtml(chapter: BuiltChapter, language: string): string {
  const body = `    <section>
      <h1>${escapeXml(chapter.title)}</h1>
${notesXhtml('Summary:', chapter.summary)}${notesXhtml('Notes:', chapter.notes)}${blocksToXhtml(chapter.paragraphs)}
${notesXhtml('Notes:', chapter.endNotes, ' end-notes')}    </section>`;
  return xhtmlDocument(chapter.title, language, body);
}

/**
 * Prefazione nello stile degli EPUB di AO3: la pipeline di import legge da qui
 * le coppie «Etichetta: valore» (fandom, rating, coppie, tag, parole, capitoli...).
 */
function prefaceXhtml(
  resolved: Resolved,
  workId: string,
  chapterCount: number,
  workNotes: { start: EfpParagraph[]; end: EfpParagraph[] },
  language: string,
): string {
  const { details, progress } = resolved;
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: string | string[]) => {
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (text.trim()) rows.push([label, text.trim()]);
  };
  add('Rating', details.rating);
  add('Archive Warning', details.warnings);
  add('Category', details.categories);
  add('Fandom', details.fandoms);
  add('Relationship', details.relationships);
  add('Character', details.characters);
  add('Additional Tags', details.extraTags);
  add('Language', languageName(details.language));
  const series = seriesOf(details);
  if (series) add('Series', series.index !== null ? `Part ${series.index} of ${series.name}` : series.name);
  add('Published', details.published);
  if (details.completed) add('Completed', details.completed);
  else if (details.updated) add('Updated', details.updated);
  if (details.words !== null) add('Words', String(details.words));
  add('Chapters', `${chapterCount}/${progress.total ?? '?'}`);
  add('Status', progress.complete ? 'Complete' : 'Incomplete');

  const summary = details.summary
    ? details.summary
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `      <p>${escapeXml(line)}</p>`)
        .join('\n')
    : '';
  const url = `http://archiveofourown.org/works/${workId}`;
  const lines = [
    `      <h1>${escapeXml(details.title)}</h1>`,
    `      <p class="byline">by ${escapeXml(details.authors.join(', ') || 'Anonymous')}</p>`,
    `      <p>Posted originally on the Archive of Our Own at <a href="${url}">${url}</a>.</p>`,
    `      <p>Recuperata dal Web Archive, copia del ${escapeXml(formatSnapshotDate(resolved.snapshot))}</p>`,
    ...rows.map(([label, value]) => `      <p>${escapeXml(label)}: ${escapeXml(value)}</p>`),
  ];
  if (summary) lines.push('      <p>Summary:</p>', summary);
  const start = notesXhtml('Notes:', workNotes.start);
  const end = notesXhtml('End Notes:', workNotes.end);
  const body = `    <section class="preface">
${lines.join('\n')}
${start}${end}    </section>`;
  return xhtmlDocument('Preface', language, body);
}

/** Costruisce un EPUB 3 nello stile di quelli di AO3 a partire dalle pagine archiviate. */
async function buildWaybackEpub(resolved: Resolved, workId: string): Promise<{ buffer: Buffer; chapters: number; words: number }> {
  const { details } = resolved;
  const built = buildChapters(resolved.chapters ?? [], details.title);
  const language = normalizeLanguage(details.language) || 'en';
  const words =
    details.words ??
    built.reduce(
      (sum, chapter) =>
        sum +
        chapter.paragraphs.reduce(
          (inner, paragraph) => inner + (paragraphText(paragraph).match(/\S+/g)?.length ?? 0),
          0,
        ),
      0,
    );

  const cover = await renderCover({
    title: details.title,
    author: details.authors.join(', '),
    fandom: details.fandoms.join(', '),
    genres: [details.rating, ...details.categories].filter(Boolean),
  });

  const workNotes = {
    start: resolved.workStart ? htmlToBlocks(resolved.workStart) : [],
    end: resolved.workEnd ? htmlToBlocks(resolved.workEnd) : [],
  };

  const zip = new AdmZip(undefined, { noSort: true });
  const mimetype = zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  mimetype.header.method = 0;

  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const series = seriesOf(details);
  const subjects = [...new Set([...details.warnings, ...details.categories, ...details.extraTags])]
    .filter(Boolean)
    .map((tag) => `    <dc:subject>${escapeXml(tag)}</dc:subject>`)
    .join('\n');
  const creators = (details.authors.length ? details.authors : ['Anonymous'])
    .map((author) => `    <dc:creator>${escapeXml(author)}</dc:creator>`)
    .join('\n');
  const seriesMeta = series
    ? `    <meta property="belongs-to-collection" id="series">${escapeXml(series.name)}</meta>\n` +
      '    <meta refines="#series" property="collection-type">series</meta>' +
      (series.index !== null
        ? `\n    <meta refines="#series" property="group-position">${series.index}</meta>`
        : '')
    : '';
  const date = details.published ? `    <dc:date>${escapeXml(details.published)}</dc:date>\n` : '';
  const coverMeta = cover ? '    <meta name="cover" content="cover-image"/>\n' : '';
  const coverManifest = cover
    ? '    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>\n' +
      '    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n'
    : '';
  const coverSpine = cover ? '    <itemref idref="cover"/>\n' : '';
  const manifest = built
    .map((chapter) => `    <item id="cap-${chapter.number}" href="cap-${chapter.number}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spine = built.map((chapter) => `    <itemref idref="cap-${chapter.number}"/>`).join('\n');
  const navItems = [
    '        <li><a href="preface.xhtml">Preface</a></li>',
    ...built.map((chapter) => `        <li><a href="cap-${chapter.number}.xhtml">${escapeXml(chapter.title)}</a></li>`),
  ].join('\n');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">ao3-${workId}</dc:identifier>
    <dc:title>${escapeXml(details.title)}</dc:title>
${creators}
    <dc:language>${escapeXml(language)}</dc:language>
    <dc:source>https://archiveofourown.org/works/${workId}</dc:source>
${date}    <dc:description>${escapeXml(details.summary)}</dc:description>
${subjects}
${seriesMeta}
    <meta property="dcterms:modified">${modified}</meta>
${coverMeta}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${coverManifest}    <item id="preface" href="preface.xhtml" media-type="application/xhtml+xml"/>
${manifest}
  </manifest>
  <spine>
${coverSpine}    <itemref idref="preface"/>
${spine}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
  <head><title>${escapeXml(details.title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${escapeXml(details.title)}</h1>
      <ol>
${navItems}
      </ol>
    </nav>
  </body>
</html>`;

  zip.addFile('META-INF/container.xml', Buffer.from(EPUB_CONTAINER_XML, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  zip.addFile('OEBPS/style.css', Buffer.from(`${EPUB_CSS}${EXTRA_CSS}`, 'utf8'));
  if (cover) {
    zip.addFile('OEBPS/cover.png', cover);
    zip.addFile('OEBPS/cover.xhtml', Buffer.from(coverXhtml({ title: details.title }), 'utf8'));
  }
  zip.addFile(
    'OEBPS/preface.xhtml',
    Buffer.from(prefaceXhtml(resolved, workId, built.length, workNotes, language), 'utf8'),
  );
  for (const chapter of built) {
    zip.addFile(`OEBPS/cap-${chapter.number}.xhtml`, Buffer.from(chapterXhtml(chapter, language), 'utf8'));
  }
  return { buffer: zip.toBuffer(), chapters: built.length, words };
}

/* ---------------------------------------------------------------- import -- */

export interface WaybackImportResult {
  book: BookMeta;
  chapters: number;
  words: number;
  /** Data (14 cifre) della copia del Web Archive usata. */
  snapshot: string;
  source: 'epub' | 'html';
}

/**
 * Importa nella libreria un'opera AO3 dal Web Archive. Con `force` salta il
 * controllo dei doppioni; altrimenti, se l'opera c'e' gia', restituisce il
 * doppione senza scrivere nulla.
 */
export async function importAo3FromWayback(
  input: string,
  options: { force?: boolean } = {},
): Promise<WaybackImportResult | { duplicate: DuplicateMatch }> {
  const parsed = parseWaybackInput(input);
  if (!options.force) {
    // Opera AO3 gia' in libreria: si risponde subito, senza interrogare il Web Archive.
    const known = await findDuplicateByMeta({ ao3Url: `https://archiveofourown.org/works/${parsed.workId}` });
    if (known) return { duplicate: known };
  }
  const ctx: Context = {
    workId: parsed.workId,
    target: parsed.timestamp,
    counter: { requests: 0 },
    cache: new Map(),
  };

  const resolved = await resolveWork(ctx);
  const epub =
    resolved.kind === 'epub' && resolved.epub
      ? { buffer: resolved.epub, chapters: 0, words: 0 }
      : await buildWaybackEpub(resolved, parsed.workId);

  const workDir = await makeWorkDir();
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const file = path.join(workDir, `${sanitizeFolderName(resolved.details.title)}.epub`);
    await fsp.writeFile(file, epub.buffer);
    const prepared = await prepareImport(file, { force: options.force });
    cleanup = prepared.cleanup;
    if (!options.force) {
      const duplicate = prepared.duplicate ?? (await findDuplicate(prepared.path));
      if (duplicate) return { duplicate };
    }
    const meta = await importPath(prepared.path, { original: prepared.original });
    await syncAppleBooksForBooks([meta.id]);
    const book = (await getBookMeta(meta.id)) ?? meta;
    return {
      book,
      chapters: book.chapters ?? epub.chapters,
      words: book.wordCount ?? epub.words,
      snapshot: resolved.snapshot,
      source: resolved.kind,
    };
  } finally {
    await cleanup?.();
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}
