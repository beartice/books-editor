import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { JELLYFIN_PATH_MAP, JELLYFIN_SYNC_MINUTES } from './config.js';
import {
  JellyfinConnectionError,
  JellyfinError,
  adminUserId,
  jellyfinFetch,
  listJellyfinBooks,
  type JellyfinItem,
} from './jellyfin.js';
import { onBookEvent, type BookEventReason } from './bookEvents.js';
import { allLibraries, currentLibrary, runInLibrary, type LibraryInfo } from './libraries.js';
import { getBookMeta, writeBookJsonPublic } from './library.js';
import { loadIndex, loadIndexFor, loadSettings, saveIndex } from './store.js';
import { bookGenres } from '../../shared/genres.js';
import type {
  BookEdition,
  BookMeta,
  JellyfinSyncInfo,
  JellyfinSyncState,
  JellyfinUnmatchedItem,
} from '../../shared/types.js';

/*
 * Jellyfin legge direttamente la cartella delle librerie; books-editor e' l'unico
 * a scrivere i file e ne invia i metadati a Jellyfin.
 *  1. Abbinamento: ogni elemento `Book` di Jellyfin ha un `Path`, che con la mappatura
 *     dei percorsi (JELLYFIN_PATH_MAP) diventa il file di una scheda.
 *  2. Invio: `GET /Items/{id}` (DTO completo), campi cambiati, `POST /Items/{id}` con
 *     `LockData` (cosi' «Aggiorna metadati» di Jellyfin non li sovrascrive) e copertina.
 *  3. File secondari (originali MOBI/AZW3, file extra): un `.ignore` per cartella li
 *     nasconde a Jellyfin, che altrimenti li mostrerebbe come libri a parte.
 * Verso Jellyfin si fanno solo GET e POST: mai DELETE.
 */

/** Tempi in ms; le variabili servono solo alle prove. */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback;
}
const PUSH_DEBOUNCE_MS = envMs('JELLYFIN_PUSH_DEBOUNCE_MS', 5_000);
const SCAN_DEBOUNCE_MS = envMs('JELLYFIN_SCAN_DEBOUNCE_MS', 3 * 60_000);
const SCAN_MIN_INTERVAL_MS = envMs('JELLYFIN_SCAN_MIN_INTERVAL_MS', 10 * 60_000);
/** Dopo la richiesta di aggiornamento Jellyfin ha bisogno di tempo: si riprova a intervalli crescenti. */
const FOLLOW_UP_MS = [2, 5, 10].map((minutes) => envMs('JELLYFIN_FOLLOW_UP_MS', minutes * 60_000));
const FIRST_ROUND_DELAY_MS = envMs('JELLYFIN_FIRST_ROUND_MS', 60_000);
const MAX_UNMATCHED_SHOWN = 200;
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const IGNORE_FILE = '.ignore';
const IGNORE_MARK = '# Generato da books-editor';

/** Estensioni che Jellyfin (BookResolver) riconosce come libri: solo queste vanno nascoste. */
const JELLYFIN_BOOK_EXTENSIONS = new Set([
  '.azw', '.azw3', '.cb7', '.cbr', '.cbt', '.cbz', '.epub', '.mobi', '.pdf',
]);

const COVER_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/* ------------------------------------------------- mappatura dei percorsi -- */

export interface PathMapEntry {
  /** Prefisso come lo vede Jellyfin. */
  from: string;
  /** Prefisso corrispondente per questo server. */
  to: string;
}

/** Percorso confrontabile: Unicode NFC, barre dritte, niente barre doppie o finali. */
export function normalizePath(value: string): string {
  return value.normalize('NFC').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}

/** `da=a;altro=altra`: il primo `=` separa le due parti, le voci incomplete si scartano. */
export function parsePathMap(raw: string): PathMapEntry[] {
  const entries: PathMapEntry[] = [];
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const from = normalizePath(part.slice(0, at).trim());
    const to = normalizePath(part.slice(at + 1).trim());
    if (to) entries.push({ from, to });
  }
  // Il prefisso piu' lungo vince.
  return entries.sort((left, right) => right.from.length - left.from.length);
}

/**
 * Percorso di Jellyfin nel percorso di questo server, oppure null se nessun prefisso
 * corrisponde. Senza mappatura i percorsi si considerano uguali.
 */
export function mapJellyfinPath(jellyfinPath: string, map: PathMapEntry[]): string | null {
  const value = normalizePath(jellyfinPath);
  if (!map.length) return value;
  for (const entry of map) {
    if (value === entry.from) return entry.to;
    if (value.startsWith(`${entry.from}/`)) return entry.to + value.slice(entry.from.length);
  }
  return null;
}

const PATH_MAP = parsePathMap(JELLYFIN_PATH_MAP);

/* ---------------------------------------------------------- abbinamento -- */

export type FileRole = 'main' | 'edition' | 'secondary';

export interface FileRef {
  libraryId: string;
  bookId: string;
  role: FileRole;
}

/** Chiave di una scheda: gli id sono unici per libreria, non fra librerie. */
function bookKey(libraryId: string, bookId: string): string {
  return `${libraryId}:${bookId}`;
}

/** Tutti i file noti delle schede (percorso del server, normalizzato) con il loro ruolo. */
export function buildFileIndex(
  libraries: Array<{ library: Pick<LibraryInfo, 'id' | 'root'>; books: BookMeta[] }>,
): Map<string, FileRef> {
  const files = new Map<string, FileRef>();
  const add = (library: Pick<LibraryInfo, 'id' | 'root'>, book: BookMeta, file: string | null | undefined, role: FileRole) => {
    if (!file) return;
    const key = normalizePath(path.resolve(library.root, book.folder, file));
    // Il ruolo piu' importante vince se lo stesso file compare in piu' elenchi.
    const current = files.get(key);
    if (current && (current.role === 'main' || role === 'secondary')) return;
    files.set(key, { libraryId: library.id, bookId: book.id, role });
  };
  for (const { library, books } of libraries) {
    for (const book of books) {
      add(library, book, book.sourceFile, 'main');
      for (const edition of book.editions ?? []) add(library, book, edition.file, 'edition');
      add(library, book, book.originalFile, 'secondary');
      for (const extra of book.extraFiles ?? []) add(library, book, extra, 'secondary');
    }
  }
  return files;
}

export interface MatchResult {
  /** Elementi Jellyfin di ogni scheda (chiave `libreria:scheda`). */
  byBook: Map<string, string[]>;
  /** Elementi che sono file secondari di una scheda (originali, extra). */
  secondary: number;
  unmatched: JellyfinUnmatchedItem[];
}

export function matchItems(
  items: JellyfinItem[],
  files: Map<string, FileRef>,
  map: PathMapEntry[],
): MatchResult {
  const result: MatchResult = { byBook: new Map(), secondary: 0, unmatched: [] };
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.Id)) continue;
    seen.add(item.Id);
    const mapped = item.Path ? mapJellyfinPath(item.Path, map) : null;
    const ref = mapped ? files.get(mapped) : undefined;
    if (!ref) {
      result.unmatched.push({
        id: item.Id,
        name: (item.Name ?? '').trim() || path.posix.basename(item.Path ?? '') || item.Id,
        path: item.Path ?? '',
        reason: item.Path && mapped === null ? 'unmapped' : 'unknown',
      });
      continue;
    }
    if (ref.role === 'secondary') {
      result.secondary += 1;
      continue;
    }
    const key = bookKey(ref.libraryId, ref.bookId);
    const ids = result.byBook.get(key);
    if (ids) ids.push(item.Id);
    else result.byBook.set(key, [item.Id]);
  }
  return result;
}

/* ------------------------------------------------- file .ignore (nascondere) -- */

/**
 * File della cartella che Jellyfin mostrerebbe come libri a parte ma che non sono
 * il file principale ne' un'edizione: l'originale convertito (MOBI, AZW3...) e i
 * file extra. Le edizioni in altre lingue restano visibili: sono libri leggibili
 * a pieno titolo, e ricevono dalla scheda il proprio titolo.
 */
export function secondaryBookFiles(book: BookMeta): string[] {
  const keep = new Set<string>(
    [book.sourceFile, ...(book.editions ?? []).map((edition) => edition.file)].filter(
      (file): file is string => Boolean(file),
    ),
  );
  const names = [book.originalFile, ...(book.extraFiles ?? [])];
  const result: string[] = [];
  for (const name of names) {
    if (!name || keep.has(name) || result.includes(name)) continue;
    if (JELLYFIN_BOOK_EXTENSIONS.has(path.extname(name).toLowerCase())) result.push(name);
  }
  return result;
}

/**
 * Riga di `.ignore` (sintassi gitignore) che esclude un nome di file. I caratteri
 * speciali (`* ? [ ] \ ! #`, spazi ai bordi) diventano `?`: corrisponde a un carattere
 * qualunque e non richiede escape, di cui non c'e' garanzia che Jellyfin li legga.
 */
export function ignoreLine(fileName: string): string {
  return fileName
    .replace(/[\\*?[\]!#\u0000-\u001f]/g, '?')
    .replace(/^\s/, '?')
    .replace(/\s$/, '?');
}

/** true se la riga `.ignore` (con `?` come carattere qualunque) corrisponde al nome. */
export function ignoreLineMatches(line: string, fileName: string): boolean {
  const source = [...line]
    .map((char) => (char === '?' ? '[^/]' : char.replace(/[.*+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i').test(fileName);
}

/** Righe del `.ignore`: mai una che corrisponda al file principale o a un'edizione. */
export function ignoreLines(book: BookMeta): string[] {
  const protectedNames = [book.sourceFile, ...(book.editions ?? []).map((edition) => edition.file)].filter(
    (file): file is string => Boolean(file),
  );
  const lines: string[] = [];
  for (const name of secondaryBookFiles(book)) {
    const line = ignoreLine(name);
    if (protectedNames.some((file) => ignoreLineMatches(line, file))) continue;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

/**
 * Scrive (o toglie) il `.ignore` della cartella del libro. Un `.ignore` che non e'
 * nostro non si tocca; uno vuoto escluderebbe tutta la cartella, quindi senza righe
 * il file si cancella invece di svuotarlo.
 */
export async function syncIgnoreFile(library: Pick<LibraryInfo, 'root'>, book: BookMeta): Promise<'written' | 'removed' | 'unchanged' | 'foreign'> {
  const folder = path.join(library.root, book.folder);
  const target = path.join(folder, IGNORE_FILE);
  const existing = await fsp.readFile(target, 'utf8').catch(() => null);
  if (existing !== null && !existing.startsWith(IGNORE_MARK)) return 'foreign';
  const lines = ignoreLines(book);
  if (!lines.length) {
    if (existing === null) return 'unchanged';
    await fsp.rm(target, { force: true });
    return 'removed';
  }
  const content =
    `${IGNORE_MARK}: nasconde a Jellyfin i file secondari di questo libro.\n` +
    '# Viene riscritto quando la scheda cambia: non modificarlo a mano.\n' +
    `${lines.join('\n')}\n`;
  if (content === existing) return 'unchanged';
  const stat = await fsp.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) return 'unchanged';
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, target);
  return 'written';
}

/* ---------------------------------------------------- dati da inviare -- */

/** Data di uscita come anno/mese/giorno, dai formati che le schede usano ("2016-07-25", "2015-09", "2022", "Nov 03, 2014"). */
export function parseReleaseDate(value: string | null | undefined): { year: number; month: number; day: number } | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Math.min(12, Math.max(1, Number(iso[2] ?? 1)));
    const day = Math.min(31, Math.max(1, Number(iso[3] ?? 1)));
    return year >= 1000 ? { year, month, day } : null;
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  const year = /\b(\d{4})\b/.exec(text);
  return year ? { year: Number(year[1]), month: 1, day: 1 } : null;
}

/** Tag da mostrare in Jellyfin: quelli della scheda e, per le fanfiction, «Fanfiction» e il fandom. */
export function jellyfinTags(book: BookMeta): string[] {
  const all = book.kind === 'fanfic' ? ['Fanfiction', book.fandom, ...book.tags] : [...book.tags];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of all) {
    const tag = (raw ?? '').trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
  }
  return result;
}

type ItemDto = Record<string, unknown>;

/**
 * Il DTO completo dell'elemento con i campi della scheda. `POST /Items/{id}` riscrive
 * i campi uno per uno (anche il nome, il numero di volume, la data): per questo si parte
 * dal DTO letto da Jellyfin e si cambia solo cio' che la scheda decide. Un valore vuoto
 * nella scheda lascia quello di Jellyfin, tranne serie e volume, che la scheda decide sempre
 * (Jellyfin altrimenti usa il nome della cartella come serie).
 */
export function buildItemUpdate(dto: ItemDto, book: BookMeta, edition: BookEdition | null): ItemDto {
  const next: ItemDto = { ...dto };
  const title = ((edition?.title || book.title) ?? '').trim();
  // L'ordinamento (SortName) non si forza: Jellyfin lo ricava dal nome, con i numeri
  // allineati (10 dopo 2), cosa che un testo imposto da noi perderebbe.
  if (title) next.Name = title;
  if (book.description.trim()) next.Overview = book.description.trim();
  const authors = book.authors.map((author) => author.trim()).filter(Boolean);
  if (authors.length) {
    next.People = [...new Set(authors)].map((name) => ({ Name: name, Role: '', Type: 'Author' }));
  }
  const tags = jellyfinTags(book);
  if (tags.length) next.Tags = tags;
  const genres = bookGenres(book.tags);
  if (genres.length) next.Genres = genres;
  const date = parseReleaseDate(book.publishedDate);
  if (date) {
    const pad = (value: number) => String(value).padStart(2, '0');
    next.PremiereDate = `${String(date.year).padStart(4, '0')}-${pad(date.month)}-${pad(date.day)}T00:00:00.0000000Z`;
    next.ProductionYear = date.year;
  }
  // Serie: `SeriesName` e `IndexNumber` (intero) sono accettati anche dai libri (IHasSeries).
  next.SeriesName = book.series.trim();
  next.IndexNumber =
    book.seriesIndex != null && Number.isInteger(book.seriesIndex) ? book.seriesIndex : null;
  next.LockData = true;
  return next;
}

/** Impronta dei dati che la scheda manda a Jellyfin: se non cambia, non si rimanda nulla. */
export function payloadHash(book: BookMeta): string {
  const date = parseReleaseDate(book.publishedDate);
  const desired = {
    title: book.title.trim(),
    overview: book.description.trim(),
    authors: book.authors.map((author) => author.trim()).filter(Boolean),
    tags: jellyfinTags(book),
    genres: bookGenres(book.tags),
    date: date ? [date.year, date.month, date.day] : null,
    series: book.series.trim(),
    index: book.seriesIndex,
    editions: (book.editions ?? []).map((edition) => [edition.file, edition.title]),
    items: book.jellyfinSync?.itemIds ?? [],
  };
  return crypto.createHash('sha1').update(JSON.stringify(desired)).digest('hex');
}

interface CoverData {
  hash: string;
  mime: string;
  base64: string;
}

async function readCover(library: Pick<LibraryInfo, 'root'>, book: BookMeta): Promise<CoverData | null> {
  if (!book.coverFile) return null;
  const mime = COVER_MIME[path.extname(book.coverFile).toLowerCase()];
  if (!mime) return null;
  try {
    const data = await fsp.readFile(path.join(library.root, book.folder, book.coverFile));
    if (!data.length || data.length > MAX_COVER_BYTES) return null;
    return {
      hash: crypto.createHash('sha1').update(data).digest('hex'),
      mime,
      base64: data.toString('base64'),
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- stato -- */

interface Runtime {
  running: boolean;
  phase: JellyfinSyncState['phase'];
  done: number;
  total: number;
  pushed: number;
  skipped: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  matchedAt: string | null;
  jellyfinItems: number;
  secondaryItems: number;
  unmatchedCount: number;
  unmatched: JellyfinUnmatchedItem[];
  lastScanAt: string | null;
  error: string | null;
}

const runtime: Runtime = {
  running: false,
  phase: null,
  done: 0,
  total: 0,
  pushed: 0,
  skipped: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
  matchedAt: null,
  jellyfinItems: 0,
  secondaryItems: 0,
  unmatchedCount: 0,
  unmatched: [],
  lastScanAt: null,
  error: null,
};

interface SyncConfig {
  configured: boolean;
  libraryId: string;
  pushEnabled: boolean;
}

async function syncConfig(): Promise<SyncConfig> {
  const settings = await loadSettings();
  const libraryId = (settings.jellyfinBooksLibraryId ?? '').trim();
  const configured = Boolean(
    (settings.jellyfinUrl ?? '').trim() && (settings.jellyfinApiKey ?? '').trim() && libraryId,
  );
  return { configured, libraryId, pushEnabled: configured && settings.jellyfinPushEnabled !== false };
}

export async function getJellyfinSyncState(): Promise<JellyfinSyncState> {
  const config = await syncConfig();
  let matchedBooks = 0;
  let booksWithError = 0;
  let lastPushAt: string | null = null;
  for (const library of await allLibraries()) {
    for (const book of await loadIndexFor(library)) {
      const sync = book.jellyfinSync;
      if (!sync?.itemIds?.length) continue;
      matchedBooks += 1;
      if (sync.error) booksWithError += 1;
      if (sync.pushedAt && (!lastPushAt || sync.pushedAt > lastPushAt)) lastPushAt = sync.pushedAt;
    }
  }
  return {
    configured: config.configured,
    pushEnabled: config.pushEnabled,
    pathMapSet: PATH_MAP.length > 0,
    running: runtime.running,
    phase: runtime.phase,
    done: runtime.done,
    total: runtime.total,
    pushed: runtime.pushed,
    skipped: runtime.skipped,
    errors: runtime.errors,
    startedAt: runtime.startedAt,
    finishedAt: runtime.finishedAt,
    matchedAt: runtime.matchedAt,
    matchedBooks,
    booksWithError,
    jellyfinItems: runtime.jellyfinItems,
    secondaryItems: runtime.secondaryItems,
    unmatchedCount: runtime.unmatchedCount,
    unmatched: runtime.unmatched,
    lastPushAt,
    lastScanAt: runtime.lastScanAt,
    error: runtime.error,
  };
}

/* --------------------------------------------- scrittura sulla scheda -- */

const emptySync = (): JellyfinSyncInfo => ({
  itemIds: [],
  pushedAt: null,
  coverHash: null,
  payloadHash: null,
  checkedAt: null,
  error: null,
});

interface SyncChange {
  bookId: string;
  change: (sync: JellyfinSyncInfo) => JellyfinSyncInfo;
  /** Nuovo valore di `identifiers.jellyfin` (null = toglierlo), dato quello attuale. */
  identifier?: (current: string | undefined) => string | null;
}

/**
 * Salva sulle schede (indice e book.json) solo i campi di Jellyfin, con una sola
 * scrittura dell'indice. Non passa da `updateBook`: non e' una modifica dell'utente,
 * quindi non cambia la data di modifica ne' fa partire un nuovo invio. Un errore
 * qui non deve fermare nessuno.
 */
async function saveSyncBatch(library: LibraryInfo, changes: SyncChange[]): Promise<void> {
  if (!changes.length) return;
  await runInLibrary(library, async () => {
    try {
      const index = await loadIndex();
      const written: BookMeta[] = [];
      for (const { bookId, change, identifier } of changes) {
        const position = index.findIndex((book) => book.id === bookId);
        if (position === -1) continue;
        const current = index[position];
        const next: BookMeta = {
          ...current,
          jellyfinSync: change({ ...emptySync(), ...(current.jellyfinSync ?? {}) }),
        };
        if (identifier) {
          const value = identifier(current.identifiers?.jellyfin);
          const identifiers = { ...(current.identifiers ?? {}) };
          if (value) identifiers.jellyfin = value;
          else delete identifiers.jellyfin;
          next.identifiers = identifiers;
        }
        index[position] = next;
        written.push(next);
      }
      for (const book of written) await writeBookJsonPublic(path.join(library.root, book.folder), book);
      await saveIndex(index);
    } catch (error) {
      console.error('[jellyfin] impossibile salvare lo stato delle schede:', error);
    }
  });
}

function saveSyncFields(
  library: LibraryInfo,
  bookId: string,
  change: SyncChange['change'],
): Promise<void> {
  return saveSyncBatch(library, [{ bookId, change }]);
}

/* ---------------------------------------------------------- abbinamento -- */

/** Schede nuove ancora senza elemento Jellyfin: dopo la richiesta di aggiornamento si riprova. */
const awaitingMatch = new Set<string>();

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().join(',') === [...right].sort().join(',');
}

/** Elenca i libri di Jellyfin e li abbina alle schede di tutte le librerie. */
async function matchAll(libraryId: string): Promise<void> {
  const items = await listJellyfinBooks(libraryId);
  const libraries = await allLibraries();
  const fileIndex = buildFileIndex(
    await Promise.all(libraries.map(async (library) => ({ library, books: await loadIndexFor(library) }))),
  );
  const result = matchItems(items, fileIndex, PATH_MAP);
  runtime.matchedAt = new Date().toISOString();
  runtime.jellyfinItems = items.length;
  runtime.secondaryItems = result.secondary;
  runtime.unmatchedCount = result.unmatched.length;
  runtime.unmatched = result.unmatched.slice(0, MAX_UNMATCHED_SHOWN);
  // Una libreria Jellyfin vuota (scansione in corso?) non deve cancellare gli abbinamenti.
  if (!items.length) return;

  for (const library of libraries) {
    const changes: SyncChange[] = [];
    for (const book of await loadIndexFor(library)) {
      const key = bookKey(library.id, book.id);
      const wanted = result.byBook.get(key) ?? [];
      const known = book.jellyfinSync?.itemIds ?? [];
      if (wanted.length) awaitingMatch.delete(key);
      if (sameIds(wanted, known)) continue;
      changes.push({
        bookId: book.id,
        // Elementi nuovi: ricevono tutto da capo.
        change: () => ({ ...emptySync(), itemIds: wanted }),
        identifier: (current) => {
          if (wanted.length) return wanted.join(',');
          // Abbinamento perso: l'id che avevamo scritto noi non vale piu'.
          return current && sameIds(current.split(','), known) ? null : (current ?? null);
        },
      });
    }
    await saveSyncBatch(library, changes);
  }
}

/* --------------------------------------------------------------- invio -- */

type PushOutcome = 'pushed' | 'skipped' | 'unmatched' | 'error' | 'gone';

async function itemDto(userId: string, itemId: string): Promise<ItemDto | null> {
  const response = await jellyfinFetch(`/Items/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(userId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new JellyfinError(`Jellyfin ha risposto con errore ${response.status}`);
  try {
    return (await response.json()) as ItemDto;
  } catch {
    throw new JellyfinError('Risposta di Jellyfin non valida');
  }
}

/** Edizione a cui corrisponde l'elemento Jellyfin (dal nome del file), null per il file principale. */
function editionOf(book: BookMeta, dto: ItemDto): BookEdition | null {
  const itemPath = typeof dto.Path === 'string' ? dto.Path : '';
  const mapped = itemPath ? mapJellyfinPath(itemPath, PATH_MAP) : null;
  if (!mapped) return null;
  const name = path.posix.basename(mapped);
  return (book.editions ?? []).find((edition) => edition.file.normalize('NFC') === name) ?? null;
}

async function pushBook(
  library: LibraryInfo,
  bookId: string,
  options: { force?: boolean } = {},
): Promise<PushOutcome> {
  const book = await runInLibrary(library, () => getBookMeta(bookId));
  if (!book) return 'gone';
  const sync = book.jellyfinSync;
  if (!sync?.itemIds?.length) return 'unmatched';

  const now = new Date().toISOString();
  const hash = payloadHash(book);
  const cover = await readCover(library, book);
  const metaSame = !options.force && sync.payloadHash === hash && !sync.error;
  const coverSame = !cover || (!options.force && cover.hash === sync.coverHash);
  if (metaSame && coverSame) {
    await saveSyncFields(library, bookId, (current) => ({ ...current, checkedAt: now }));
    return 'skipped';
  }

  const failures: string[] = [];
  try {
    const userId = await adminUserId();
    for (const itemId of sync.itemIds) {
      const dto = await itemDto(userId, itemId);
      if (!dto) {
        failures.push('un elemento non esiste piu\' su Jellyfin (si riabbina con «Aggiorna Jellyfin ora»)');
        continue;
      }
      if (!metaSame) {
        const response = await jellyfinFetch(`/Items/${encodeURIComponent(itemId)}`, {
          method: 'POST',
          body: JSON.stringify(buildItemUpdate(dto, book, editionOf(book, dto))),
          contentType: 'application/json',
        });
        if (!response.ok) {
          failures.push(`Jellyfin ha rifiutato i metadati (errore ${response.status})`);
          continue;
        }
      }
      if (cover && !coverSame) {
        // Il corpo e' l'immagine in base64, con il tipo dell'immagine come Content-Type.
        const response = await jellyfinFetch(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, {
          method: 'POST',
          body: cover.base64,
          contentType: cover.mime,
          timeoutMs: 60_000,
        });
        if (!response.ok) failures.push(`Jellyfin ha rifiutato la copertina (errore ${response.status})`);
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    await saveSyncFields(library, bookId, (current) => ({ ...current, error: message }));
    if (error instanceof JellyfinConnectionError) throw error;
    return 'error';
  }

  if (failures.length) {
    const message = [...new Set(failures)].join('; ');
    await saveSyncFields(library, bookId, (current) => ({ ...current, error: message }));
    return 'error';
  }
  await saveSyncFields(library, bookId, (current) => ({
    ...current,
    pushedAt: now,
    checkedAt: now,
    payloadHash: hash,
    coverHash: cover?.hash ?? current.coverHash,
    error: null,
  }));
  return 'pushed';
}

/* ------------------------------------------------------------------ coda -- */

/** Una richiesta alla volta verso Jellyfin: i compiti si accodano. */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.catch(() => undefined);
  return next;
}

const pushTimers = new Map<string, NodeJS.Timeout>();

/** Dopo una modifica attende un po' (altre modifiche ravvicinate si uniscono) e poi invia. */
function schedulePush(library: LibraryInfo, bookId: string): void {
  const key = bookKey(library.id, bookId);
  clearTimeout(pushTimers.get(key));
  const timer = setTimeout(() => {
    pushTimers.delete(key);
    void enqueue(async () => {
      if (!(await syncConfig()).pushEnabled) return;
      await pushBook(library, bookId);
    }).catch((error) => console.error('[jellyfin] invio non riuscito:', (error as Error).message));
  }, PUSH_DEBOUNCE_MS);
  timer.unref();
  pushTimers.set(key, timer);
}

/* ---------------------------------------------------- giro completo -- */

async function writeAllIgnoreFiles(): Promise<void> {
  for (const library of await allLibraries()) {
    for (const book of await loadIndexFor(library)) {
      await syncIgnoreFile(library, book).catch(() => undefined);
    }
  }
}

function needsPush(book: BookMeta, force: boolean): boolean {
  const sync = book.jellyfinSync;
  if (!sync?.itemIds?.length) return false;
  if (force || !sync.pushedAt || sync.error) return true;
  return book.dateModified > (sync.checkedAt ?? sync.pushedAt);
}

/**
 * Giro completo: `.ignore` dei file secondari, abbinamento con Jellyfin, invio delle
 * schede che ne hanno bisogno (tutte con `force`). Con `push: false` si ferma all'abbinamento.
 */
async function runRound(options: { force: boolean; push: boolean }): Promise<void> {
  runtime.error = null;
  try {
    const config = await syncConfig();
    if (!config.configured) throw new JellyfinError('Jellyfin non e\' configurato: imposta indirizzo, chiave e libreria dei libri');

    runtime.phase = 'ignore';
    await writeAllIgnoreFiles();

    runtime.phase = 'match';
    await enqueue(() => matchAll(config.libraryId));

    if (!options.push) return;
    runtime.phase = 'push';
    const todo: Array<{ library: LibraryInfo; bookId: string }> = [];
    for (const library of await allLibraries()) {
      for (const book of await loadIndexFor(library)) {
        if (needsPush(book, options.force)) todo.push({ library, bookId: book.id });
      }
    }
    runtime.total = todo.length;
    for (const { library, bookId } of todo) {
      const outcome = await enqueue(() => pushBook(library, bookId, { force: options.force }));
      runtime.done += 1;
      if (outcome === 'pushed') runtime.pushed += 1;
      else if (outcome === 'error') runtime.errors += 1;
      else runtime.skipped += 1;
    }
  } catch (error) {
    runtime.error = (error as Error).message;
    console.error('[jellyfin] giro non riuscito:', runtime.error);
  }
}

function beginRound(): void {
  Object.assign(runtime, {
    running: true,
    phase: 'ignore',
    done: 0,
    total: 0,
    pushed: 0,
    skipped: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });
}

function endRound(): void {
  runtime.running = false;
  runtime.phase = null;
  runtime.finishedAt = new Date().toISOString();
}

/** Avvia il giro in background («Aggiorna Jellyfin ora»); un solo giro alla volta. */
export async function startJellyfinSync(options: { force?: boolean } = {}): Promise<JellyfinSyncState> {
  if (runtime.running) throw new JellyfinError('Un aggiornamento di Jellyfin e\' gia\' in corso');
  const config = await syncConfig();
  if (!config.configured) {
    throw new JellyfinError('Jellyfin non e\' configurato: imposta indirizzo, chiave e libreria dei libri nelle Impostazioni');
  }
  beginRound();
  void runRound({ force: options.force === true, push: true }).finally(endRound);
  return getJellyfinSyncState();
}

/** Giro automatico (periodico o dopo la scansione di Jellyfin): non interferisce con uno manuale. */
async function automaticRound(): Promise<void> {
  if (runtime.running) return;
  const config = await syncConfig();
  if (!config.configured) return;
  beginRound();
  try {
    await runRound({ force: false, push: config.pushEnabled });
  } finally {
    endRound();
  }
}

/** «Invia a Jellyfin» dalla scheda: abbina se serve, poi invia tutto. */
export async function pushBookNow(bookId: string): Promise<BookMeta> {
  const config = await syncConfig();
  if (!config.configured) {
    throw new JellyfinError('Jellyfin non e\' configurato: imposta indirizzo, chiave e libreria dei libri nelle Impostazioni');
  }
  const library = currentLibrary();
  const outcome = await enqueue(async () => {
    let book = await runInLibrary(library, () => getBookMeta(bookId));
    if (!book) throw new JellyfinError('Libro non trovato');
    await syncIgnoreFile(library, book).catch(() => undefined);
    if (!book.jellyfinSync?.itemIds?.length) {
      await matchAll(config.libraryId);
      book = await runInLibrary(library, () => getBookMeta(bookId));
    }
    if (!book?.jellyfinSync?.itemIds?.length) {
      throw new JellyfinError(
        'Questo libro non e\' ancora in Jellyfin: Jellyfin vede i file nuovi solo dopo una sua scansione della libreria',
      );
    }
    return pushBook(library, bookId, { force: true });
  });
  const updated = await runInLibrary(library, () => getBookMeta(bookId));
  if (outcome === 'error') throw new JellyfinError(updated?.jellyfinSync?.error || 'Invio a Jellyfin non riuscito');
  if (!updated) throw new JellyfinError('Libro non trovato');
  return updated;
}

/* ------------------------------------------- scansione della libreria -- */

let scanTimer: NodeJS.Timeout | null = null;
let followUpTimer: NodeJS.Timeout | null = null;
let lastScanMs = 0;

/** Chiede a Jellyfin di aggiornare la sola libreria dei libri (nessuna sostituzione di metadati). */
async function requestScan(libraryId: string): Promise<void> {
  const query =
    'metadataRefreshMode=Default&imageRefreshMode=Default&replaceAllMetadata=false&replaceAllImages=false';
  const response = await jellyfinFetch(`/Items/${encodeURIComponent(libraryId)}/Refresh?${query}`, {
    method: 'POST',
  });
  if (!response.ok) throw new JellyfinError(`Jellyfin ha risposto con errore ${response.status}`);
  lastScanMs = Date.now();
  runtime.lastScanAt = new Date(lastScanMs).toISOString();
}

function scheduleFollowUp(attempt: number): void {
  if (attempt >= FOLLOW_UP_MS.length) {
    awaitingMatch.clear();
    return;
  }
  clearTimeout(followUpTimer ?? undefined);
  followUpTimer = setTimeout(() => {
    followUpTimer = null;
    void automaticRound()
      .catch((error) => console.error('[jellyfin] giro dopo la scansione non riuscito:', (error as Error).message))
      .then(() => {
        if (awaitingMatch.size > 0) scheduleFollowUp(attempt + 1);
      });
  }, FOLLOW_UP_MS[attempt]);
  followUpTimer.unref();
}

/**
 * Dopo un import Jellyfin vede il file solo dopo una scansione: se ne chiede una
 * dopo qualche minuto di calma, non piu' di una ogni 10 minuti. Poi si riprova
 * l'abbinamento dei libri ancora senza elemento.
 */
function scheduleScan(): void {
  clearTimeout(scanTimer ?? undefined);
  const wait = Math.max(SCAN_DEBOUNCE_MS, lastScanMs + SCAN_MIN_INTERVAL_MS - Date.now());
  scanTimer = setTimeout(() => {
    scanTimer = null;
    void (async () => {
      const config = await syncConfig();
      if (!config.pushEnabled) return;
      try {
        await requestScan(config.libraryId);
      } catch (error) {
        runtime.error = (error as Error).message;
        console.error('[jellyfin] richiesta di aggiornamento non riuscita:', runtime.error);
        return;
      }
      scheduleFollowUp(0);
    })();
  }, wait);
  scanTimer.unref();
}

/* ---------------------------------------------------------- avvio -- */

async function handleBookEvent(library: LibraryInfo, bookId: string, reason: BookEventReason): Promise<void> {
  const config = await syncConfig();
  if (!config.configured) return;
  // Il `.ignore` serve prima che Jellyfin veda la cartella, anche con l'invio spento.
  const book = await runInLibrary(library, () => getBookMeta(bookId));
  if (book) await syncIgnoreFile(library, book).catch(() => undefined);
  if (!config.pushEnabled) return;
  if (reason === 'new') {
    awaitingMatch.add(bookKey(library.id, bookId));
    scheduleScan();
  }
  schedulePush(library, bookId);
}

/** Registra l'ascolto delle modifiche e il giro periodico (JELLYFIN_SYNC_MINUTES, 0 = spento). */
export function startJellyfinSyncService(): void {
  onBookEvent((library, bookId, reason) => {
    void handleBookEvent(library, bookId, reason).catch((error) =>
      console.error('[jellyfin] avviso non gestito:', (error as Error).message),
    );
  });
  if (JELLYFIN_SYNC_MINUTES <= 0) return;
  const run = () => {
    void automaticRound().catch((error) =>
      console.error('[jellyfin] giro periodico non riuscito:', (error as Error).message),
    );
  };
  setTimeout(run, FIRST_ROUND_DELAY_MS).unref();
  setInterval(run, JELLYFIN_SYNC_MINUTES * 60_000).unref();
}
