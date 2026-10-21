import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { updateBook } from './library.js';
import { loadIndex } from './store.js';
import type {
  AppleBooksImportResult,
  AppleBooksMatched,
  AppleBooksUnmatched,
  BookHighlight,
  BookMeta,
  HighlightColor,
} from '../../shared/types.js';

const execFileAsync = promisify(execFile);

/** Apple usa il 1º gennaio 2001 come origine dei timestamp di Core Data. */
const APPLE_EPOCH = 978307200;
const MAX_BUFFER = 64 * 1024 * 1024;
/** Sotto questa soglia il titolo non viene considerato un abbinamento affidabile. */
const MATCH_THRESHOLD = 0.75;

interface AnnotationRow {
  uuid?: string | null;
  assetId?: string | null;
  text?: string | null;
  note?: string | null;
  location?: string | null;
  style?: number | string | null;
  underline?: number | string | null;
  createdAt?: number | string | null;
  modifiedAt?: number | string | null;
}

interface AppleLibraryRow {
  assetId?: string | null;
  title?: string | null;
  sortTitle?: string | null;
  author?: string | null;
  sortAuthor?: string | null;
  /** Data di fine lettura (timestamp Core Data). */
  finishedAt?: number | string | null;
  /** Avanzamento di lettura da 0 a 1. */
  readingProgress?: number | string | null;
}

interface AppleBook {
  assetId: string;
  title: string;
  sortTitle: string;
  author: string;
  count: number;
  /** Giorno in cui il libro e' stato finito (AAAA-MM-GG), vuoto se non finito. */
  finishedAt: string;
  /** Percentuale di lettura (0-100), null se assente. */
  readingProgress: number | null;
}

interface MatchPair {
  book: BookMeta;
  apple: AppleBook;
  score: number;
  /** Affidabilita' del titolo: 2 = esatto, 1 = serie/sottotitolo, 0 = debole. */
  titleRank: number;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

/**
 * Cartelle `Data/Documents` candidate. `APPLE_BOOKS_CONTAINER` può puntare al
 * container oppure alla cartella Documents (utile per i backup).
 */
export function documentsCandidates(): string[] {
  const candidates: string[] = [];
  const configured = process.env.APPLE_BOOKS_CONTAINER?.trim();
  if (configured) {
    const root = expandHome(configured);
    candidates.push(path.join(root, 'Data', 'Documents'));
    candidates.push(root);
    candidates.push(path.join(root, 'Documents'));
  }
  candidates.push(
    path.join(os.homedir(), 'Library/Containers/com.apple.iBooksX/Data/Documents'),
  );
  return [...new Set(candidates)];
}

async function findDatabase(dir: string, pattern: RegExp): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const files = entries.filter(
    (name) => pattern.test(name) && !name.endsWith('-wal') && !name.endsWith('-shm'),
  );
  if (!files.length) return null;
  const stats = await Promise.all(
    files.map(async (name) => {
      const file = path.join(dir, name);
      const stat = await fsp.stat(file).catch(() => null);
      return { file, at: stat?.mtimeMs ?? 0 };
    }),
  );
  stats.sort((a, b) => b.at - a.at);
  return stats[0].file;
}

export async function locateDatabases(): Promise<{ annotations: string; library: string | null }> {
  for (const docs of documentsCandidates()) {
    const annotations = await findDatabase(
      path.join(docs, 'AEAnnotation'),
      /^AEAnnotation.*\.sqlite$/i,
    );
    if (!annotations) continue;
    const library = await findDatabase(
      path.join(docs, 'BKLibrary'),
      /^BKLibrary.*\.sqlite$/i,
    );
    return { annotations, library };
  }
  throw new Error(
    'Database di Apple Books non trovato. Apri Libri sul Mac almeno una volta, ' +
      'oppure imposta APPLE_BOOKS_CONTAINER sulla cartella del container (anche di un backup).',
  );
}

export async function sqliteJson<T>(database: string, sql: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      ['-json', '-readonly', database, sql],
      { maxBuffer: MAX_BUFFER },
    );
    const text = stdout.trim();
    if (!text) return [];
    return JSON.parse(text) as T[];
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        'Il comando sqlite3 non è disponibile. Su macOS è incluso nel sistema; ' +
          'negli altri ambienti l’importazione di Apple Books non è supportata.',
      );
    }
    const detail = err.stderr?.trim() || err.message;
    throw new Error(`Lettura del database Apple Books non riuscita: ${detail}`);
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function appleDate(value: unknown): string {
  const seconds = numberOrNull(value);
  if (seconds === null || seconds <= 0) return '';
  const date = new Date((seconds + APPLE_EPOCH) * 1000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** Apple salva l'avanzamento da 0 a 1: diventa una percentuale intera 0-100. */
function progressPercent(value: unknown): number | null {
  const fraction = numberOrNull(value);
  if (fraction === null || fraction <= 0) return null;
  // Un libro appena iniziato non deve risultare allo 0%.
  return Math.min(100, Math.max(1, Math.round(fraction * 100)));
}

function colorFor(style: number | null, underlined: boolean): HighlightColor {
  if (underlined) return 'underline';
  switch (style) {
    case 0:
      return 'underline';
    case 1:
      return 'green';
    case 2:
      return 'blue';
    case 3:
      return 'yellow';
    case 4:
      return 'pink';
    case 5:
      return 'purple';
    default:
      return 'none';
  }
}

/** Estrae un'etichetta leggibile dal primo segmento con bracket di un CFI EPUB. */
function chapterFromLocation(location: string): string {
  const bracket = location.match(/\[([^\]]+)\]/);
  if (!bracket) return '';
  const raw = bracket[1];
  const numbered =
    raw.match(/(?:chapter|chap|cap)[_-]?(\d+)/i) ?? raw.match(/^c(\d+)/i);
  if (numbered) return `Capitolo ${Number(numbered[1])}`;
  if (/preface|front\s*matter/i.test(raw)) return 'Prefazione';
  if (/afterword|back\s*matter/i.test(raw)) return 'Postfazione';
  if (/introduction|intro/i.test(raw)) return 'Introduzione';
  if (/appendix/i.test(raw)) return 'Appendice';
  return '';
}

/** Ordina le annotazioni nella stessa sequenza di lettura del libro. */
function parseCfiForSorting(location: string): number[] {
  if (!location.startsWith('epubcfi(')) return [Number.MAX_SAFE_INTEGER];
  const content = location.replace(/^epubcfi\(/, '').replace(/\)$/, '');
  const numbers: number[] = [];
  for (const part of content.split('!')) {
    const clean = part.replace(/\[[^\]]*\]/g, '');
    const matches = clean.match(/\d+/g);
    if (matches) numbers.push(...matches.map((value) => Number(value)));
  }
  return numbers.length ? numbers : [Number.MAX_SAFE_INTEGER];
}

function compareLocations(a: BookHighlight, b: BookHighlight): number {
  const left = parseCfiForSorting(a.location);
  const right = parseCfiForSorting(b.location);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  if (left.length !== right.length) return left.length - right.length;
  return a.createdAt.localeCompare(b.createdAt);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ARTICLES = new Set([
  'the', 'a', 'an', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una',
  'de', 'der', 'die', 'das', 'les', 'des', 'el', 'los', 'las', 'l',
]);

function titleTokens(value: string): string[] {
  const tokens = normalize(value).split(' ').filter(Boolean);
  while (tokens.length > 1 && ARTICLES.has(tokens[0])) tokens.shift();
  return [...new Set(tokens)];
}

function authorTokens(value: string): string[] {
  return [
    ...new Set(
      normalize(value)
        .split(/[\s,]+/)
        .filter((token) => token.length > 1),
    ),
  ];
}

function intersectionSize(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function titleSimilarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.length || !b.length) return 0;
  const intersection = intersectionSize(a, b);
  if (!intersection) return 0;
  const min = Math.min(a.length, b.length);
  const dice = (2 * intersection) / (a.length + b.length);
  const containment = intersection / min;
  // Titoli di una sola parola ("It", "Dune") sono troppo ambigui: contano
  // solo se combaciano esattamente o quasi.
  if (min === 1 && a.length !== b.length) return Math.min(containment, 0.7);
  return Math.max(dice, containment);
}

/** Varianti di un titolo: intero, prefissi e suffissi divisi da ":" o " - ". */
function titleVariants(value: string): string[] {
  const parts = value
    .split(/\s*[:–—]\s*|\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const variants = new Set<string>();
  for (let index = 0; index < parts.length; index += 1) {
    variants.add(normalize(parts.slice(0, index + 1).join(' ')));
    variants.add(normalize(parts.slice(index).join(' ')));
  }
  return [...variants].filter(Boolean);
}

/**
 * Abbinamento "forte" per la data di fine lettura: il titolo deve combaciare
 * per intero (2) o come prefisso/suffisso affidabile (1). Evita che un
 * sottotitolo promozionale ("... of The Love Hypothesis") o un altro volume
 * della serie ("Titolo 04 - ...") porti la data sul libro sbagliato.
 */
function titleMatchRank(bookTitle: string, apple: AppleBook): number {
  const target = normalize(bookTitle);
  if (!target) return 0;
  let rank = 0;
  for (const raw of [apple.title, apple.sortTitle]) {
    if (!raw) continue;
    for (const variant of titleVariants(raw)) {
      if (variant === target) {
        rank = 2;
      } else if (variant.startsWith(`${target} `)) {
        const rest = variant.slice(target.length + 1).trim();
        // "Titolo 04 - ..." e' un altro volume della serie, non lo stesso libro.
        if (!/^\d/.test(rest)) rank = Math.max(rank, 1);
      }
    }
  }
  return rank;
}

function authorSimilarity(left: string, right: string): number {
  const a = authorTokens(left);
  const b = authorTokens(right);
  if (!a.length || !b.length) return 0.5;
  const intersection = intersectionSize(a, b);
  if (!intersection) return 0;
  const dice = (2 * intersection) / (a.length + b.length);
  const containment = intersection / Math.min(a.length, b.length);
  return Math.max(dice, containment);
}

function matchScore(book: BookMeta, apple: AppleBook): number {
  const libraryTitle = book.title || '';
  const title = Math.max(
    titleSimilarity(libraryTitle, apple.title),
    titleSimilarity(libraryTitle, apple.sortTitle),
  );
  if (title <= 0) return 0;
  const libraryAuthors = book.authors.join(' ');
  const author = authorSimilarity(libraryAuthors, apple.author);
  if (title < 0.7) return 0;
  // Un titolo identico ma un autore completamente diverso non è un abbinamento.
  if (author < 0.5) return 0;
  if (normalize(libraryTitle).length < 3 && normalize(apple.title) !== normalize(libraryTitle)) {
    return 0;
  }
  const score = title * 0.75 + author * 0.25;
  if (score < MATCH_THRESHOLD) return 0;
  if (title < 0.9 && author < 0.8) return 0;
  return score;
}

async function readAnnotations(database: string): Promise<{
  rows: AnnotationRow[];
  count: number;
}> {
  const rows = await sqliteJson<AnnotationRow>(
    database,
    `SELECT
       ZANNOTATIONUUID AS uuid,
       ZANNOTATIONASSETID AS assetId,
       ZANNOTATIONSELECTEDTEXT AS text,
       ZANNOTATIONNOTE AS note,
       ZANNOTATIONLOCATION AS location,
       ZANNOTATIONSTYLE AS style,
       ZANNOTATIONISUNDERLINE AS underline,
       ZANNOTATIONCREATIONDATE AS createdAt,
       ZANNOTATIONMODIFICATIONDATE AS modifiedAt
     FROM ZAEANNOTATION
     WHERE ZANNOTATIONDELETED = 0
       AND trim(COALESCE(ZANNOTATIONSELECTEDTEXT, '')) <> ''`,
  );
  return { rows, count: rows.length };
}

async function readLibrary(database: string | null): Promise<Map<string, AppleLibraryRow>> {
  const map = new Map<string, AppleLibraryRow>();
  if (!database) return map;
  const rows = await sqliteJson<AppleLibraryRow>(
    database,
    `SELECT
       ZASSETID AS assetId,
       ZTITLE AS title,
       ZSORTTITLE AS sortTitle,
       ZAUTHOR AS author,
       ZSORTAUTHOR AS sortAuthor,
       ZDATEFINISHED AS finishedAt,
       ZREADINGPROGRESS AS readingProgress
     FROM ZBKLIBRARYASSET
     WHERE ZASSETID IS NOT NULL`,
  );
  for (const row of rows) {
    const assetId = String(row.assetId ?? '').trim();
    if (assetId) map.set(assetId, row);
  }
  return map;
}

function buildHighlights(rows: AnnotationRow[]): Map<string, BookHighlight[]> {
  const byAsset = new Map<string, BookHighlight[]>();
  for (const row of rows) {
    const assetId = String(row.assetId ?? '').trim();
    const text = String(row.text ?? '').trim();
    if (!assetId || !text) continue;

    const location = String(row.location ?? '').trim();
    const createdAt = appleDate(row.createdAt);
    const modifiedAt = appleDate(row.modifiedAt) || createdAt;
    const uuid = String(row.uuid ?? '').trim();
    const id =
      uuid ||
      createHash('sha1')
        .update(`${assetId}|${location}|${text}|${createdAt}`)
        .digest('hex');

    const style = numberOrNull(row.style);
    const underline = numberOrNull(row.underline) === 1;
    const highlight: BookHighlight = {
      id,
      source: 'applebooks',
      text,
      note: String(row.note ?? '').trim(),
      color: colorFor(style, underline),
      location,
      chapter: chapterFromLocation(location),
      createdAt,
      modifiedAt,
    };

    const list = byAsset.get(assetId) ?? [];
    list.push(highlight);
    byAsset.set(assetId, list);
  }
  for (const list of byAsset.values()) list.sort(compareLocations);
  return byAsset;
}

function buildAppleBooks(
  byAsset: Map<string, BookHighlight[]>,
  library: Map<string, AppleLibraryRow>,
): AppleBook[] {
  const assetIds = new Set([...byAsset.keys(), ...library.keys()]);
  const books: AppleBook[] = [];
  for (const assetId of assetIds) {
    const row = library.get(assetId);
    const highlighted = byAsset.get(assetId) ?? [];
    const finishedAt = appleDate(row?.finishedAt).slice(0, 10);
    const readingProgress = progressPercent(row?.readingProgress);
    // Servono le annotazioni, la data di fine o almeno l'avanzamento.
    if (!highlighted.length && !finishedAt && readingProgress === null) continue;
    books.push({
      assetId,
      title: String(row?.title ?? row?.sortTitle ?? '').trim(),
      sortTitle: String(row?.sortTitle ?? '').trim(),
      author: String(row?.author ?? row?.sortAuthor ?? '').trim(),
      count: highlighted.length,
      finishedAt,
      readingProgress,
    });
  }
  return books.sort(
    (a, b) => b.count - a.count || b.finishedAt.localeCompare(a.finishedAt),
  );
}

/**
 * Asset gia' collegati a un libro fuori dall'import corrente. Serve agli import
 * mirati (un solo libro): un titolo simile non deve rubare le annotazioni a un
 * libro che le ha gia' abbinate.
 */
function ownedAssets(allBooks: BookMeta[], books: BookMeta[]): Map<string, string> {
  const scoped = new Set(books.map((book) => book.id));
  const owners = new Map<string, string>();
  for (const book of allBooks) {
    const assetId = book.identifiers?.applebooks;
    if (assetId && !scoped.has(book.id)) owners.set(assetId, book.id);
  }
  return owners;
}

function assignMatches(
  books: BookMeta[],
  appleBooks: AppleBook[],
  owners: Map<string, string> = new Map(),
): MatchPair[] {
  const pairs: MatchPair[] = [];
  for (const apple of appleBooks) {
    for (const book of books) {
      const owner = owners.get(apple.assetId);
      if (owner && owner !== book.id) continue;
      const known = book.identifiers?.applebooks;
      const titleRank = titleMatchRank(book.title, apple);
      // I libri senza annotazioni entrano solo con un titolo affidabile.
      if (apple.count === 0 && titleRank === 0) continue;
      const score = known === apple.assetId ? 2 : matchScore(book, apple);
      if (score > 0) pairs.push({ book, apple, score, titleRank });
    }
  }
  pairs.sort((a, b) => {
    // Il titolo piu' affidabile vince: serve per la data di fine lettura.
    if (a.titleRank !== b.titleRank) return b.titleRank - a.titleRank;
    return b.score - a.score;
  });

  const usedBooks = new Set<string>();
  const usedAssets = new Set<string>();
  const selected: MatchPair[] = [];
  for (const pair of pairs) {
    if (usedBooks.has(pair.book.id) || usedAssets.has(pair.apple.assetId)) continue;
    usedBooks.add(pair.book.id);
    usedAssets.add(pair.apple.assetId);
    selected.push(pair);
  }
  return selected;
}

function sameHighlights(left: BookHighlight[], right: BookHighlight[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Importa da Apple Books le evidenziazioni/sottolineature (con note) e la data
 * di fine lettura, salvandole nei campi `highlights` e `dateFinished` dei libri
 * abbinati. L'operazione è idempotente: gli UUID delle annotazioni evitano
 * duplicati ai successivi import.
 *
 * Con `bookIds` l'abbinamento si limita a quei libri: e' la modalita' usata
 * dopo l'aggiunta di un'opera, cosi' la sincronizzazione resta veloce.
 */
export async function importAppleBooks(
  options: { dryRun?: boolean; bookIds?: string[] } = {},
): Promise<AppleBooksImportResult> {
  if (process.platform !== 'darwin' && !process.env.APPLE_BOOKS_CONTAINER) {
    throw new Error('L’importazione da Apple Books è disponibile solo su macOS.');
  }

  const { annotations: annotationDb, library: libraryDb } = await locateDatabases();
  const [{ rows }, libraryRows] = await Promise.all([
    readAnnotations(annotationDb),
    readLibrary(libraryDb),
  ]);

  const byAsset = buildHighlights(rows);
  const appleBooks = buildAppleBooks(byAsset, libraryRows);
  const allBooks = await loadIndex();
  const scoped = options.bookIds ? new Set(options.bookIds) : null;
  const books = scoped ? allBooks.filter((book) => scoped.has(book.id)) : allBooks;
  const matches = assignMatches(books, appleBooks, ownedAssets(allBooks, books));

  const matched: AppleBooksMatched[] = [];
  const unmatched: AppleBooksUnmatched[] = [];
  const matchedAssetIds = new Set<string>();
  let imported = 0;
  let booksUpdated = 0;
  let finishedDates = 0;
  let progressBooks = 0;

  for (const { book, apple, titleRank } of matches) {
    const highlights = byAsset.get(apple.assetId) ?? [];
    const manual = (book.highlights ?? []).filter(
      (highlight) => highlight.source !== 'applebooks',
    );
    const next = [...manual, ...highlights].sort(compareLocations);
    const identifiers = { ...book.identifiers, applebooks: apple.assetId };
    const finishedAt = apple.finishedAt && titleRank > 0 ? apple.finishedAt : '';
    const readingProgress = titleRank > 0 ? apple.readingProgress : null;
    const patch: Partial<BookMeta> = { highlights: next, identifiers };
    if (finishedAt) {
      patch.dateFinished = finishedAt;
      // La data di fine basta: Apple non compila piu' il flag "finito" per i
      // libri vecchi. Lo stato scelto a mano resta com'e'.
      if (
        (book.readingStatus === 'unread' || book.readingStatus === 'reading') &&
        book.fieldSource?.readingStatus !== 'manual'
      ) {
        patch.readingStatus = 'read';
      }
      finishedDates += 1;
    }
    if (readingProgress !== null) {
      patch.readingProgress = readingProgress;
      progressBooks += 1;
      // Un libro iniziato ma non finito diventa "In lettura", senza toccare
      // gli stati scelti a mano.
      if (
        !finishedAt &&
        readingProgress < 100 &&
        book.readingStatus === 'unread' &&
        book.fieldSource?.readingStatus !== 'manual'
      ) {
        patch.readingStatus = 'reading';
      }
    }
    const changed =
      !sameHighlights(book.highlights ?? [], next) ||
      book.identifiers?.applebooks !== apple.assetId ||
      (patch.dateFinished !== undefined &&
        (book.dateFinished ?? null) !== patch.dateFinished) ||
      (readingProgress !== null && (book.readingProgress ?? null) !== readingProgress) ||
      (patch.readingStatus !== undefined && book.readingStatus !== patch.readingStatus);

    if (changed && !options.dryRun) {
      await updateBook(book.id, patch, 'online');
    }

    matchedAssetIds.add(apple.assetId);
    matched.push({
      bookId: book.id,
      title: book.title,
      appleTitle: apple.title || apple.sortTitle,
      count: highlights.length,
      finishedAt,
      readingProgress,
    });
    imported += highlights.length;
    if (changed) booksUpdated += 1;
  }

  // L'elenco dei libri non abbinati ha senso solo per un import completo.
  if (!scoped) {
    for (const apple of appleBooks) {
      if (matchedAssetIds.has(apple.assetId)) continue;
      unmatched.push({
        assetId: apple.assetId,
        title: apple.title || apple.sortTitle || `(asset ${apple.assetId})`,
        author: apple.author,
        count: apple.count,
      });
    }
  }

  return {
    database: annotationDb,
    annotations: rows.length,
    imported,
    booksMatched: matched.length,
    booksUpdated,
    finishedDates,
    progressBooks,
    dryRun: Boolean(options.dryRun),
    matched,
    unmatched,
  };
}

/**
 * Sincronizza in silenzio Apple Books per i libri appena importati: sottolineature,
 * note, avanzamento e data di fine lettura compaiono senza passare dalle
 * Impostazioni. Un errore (macOS assente, Libri mai aperto) non deve mai far
 * fallire l'import vero e proprio.
 */
export async function syncAppleBooksForBooks(bookIds: string[]): Promise<void> {
  if (!bookIds.length) return;
  if (process.platform !== 'darwin' && !process.env.APPLE_BOOKS_CONTAINER) return;
  try {
    await importAppleBooks({ bookIds });
  } catch (error) {
    console.warn(
      `[applebooks] sincronizzazione saltata: ${(error as Error).message}`,
    );
  }
}
