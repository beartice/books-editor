import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DEFAULT_LIBRARY_ROOT, LIBRARY_ROOT_LOCKED, ensureDir } from './config.js';
import { currentLibrary, type LibraryInfo } from './libraries.js';
import type { AppSettings, BookMeta, BookSummary } from '../../shared/types.js';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/**
 * L'indice e' una cache ricostruibile: la fonte di verita' sono i file
 * `book.json` dentro ciascuna cartella della libreria.
 */
interface IndexFile {
  version: 1;
  books: BookMeta[];
}

const DEFAULT_SETTINGS: AppSettings = {
  libraryRoot: DEFAULT_LIBRARY_ROOT,
  libraryName: 'La mia libreria',
  searchLanguage: 'it',
  providers: ['googlebooks', 'openlibrary', 'goodreads'],
  autoLookup: false,
  theme: 'dark',
  wordsPerHour: 230,
  seriesRefreshDays: 30,
  showAllFields: false,
};

/** Indice in memoria, uno per libreria (chiave: id della libreria). */
const indexCaches = new Map<string, BookMeta[]>();
let settingsCache: AppSettings | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

/** Scrittura atomica: file temporaneo + rename, evita indici corrotti. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

/** Dati di una libreria che servono per leggerne o scriverne l'indice. */
type IndexTarget = Pick<LibraryInfo, 'id' | 'dataDir'>;

function indexFile(library: IndexTarget): string {
  return path.join(library.dataDir, 'index.json');
}

/** Indice della libreria indicata (la principale sta in DATA_DIR/index.json). */
export async function loadIndexFor(library: IndexTarget): Promise<BookMeta[]> {
  const cached = indexCaches.get(library.id);
  if (cached) return cached;
  let books: BookMeta[];
  try {
    const raw = await fsp.readFile(indexFile(library), 'utf8');
    const parsed = JSON.parse(raw) as IndexFile;
    books = Array.isArray(parsed.books) ? parsed.books : [];
  } catch {
    books = [];
  }
  indexCaches.set(library.id, books);
  return books;
}

export async function saveIndexFor(library: IndexTarget, books: BookMeta[]): Promise<void> {
  indexCaches.set(library.id, books);
  const payload: IndexFile = { version: 1, books };
  await queue(() => writeJsonAtomic(indexFile(library), payload));
}

/** Indice della libreria della richiesta corrente. */
export async function loadIndex(): Promise<BookMeta[]> {
  return loadIndexFor(currentLibrary());
}

export async function saveIndex(books: BookMeta[]): Promise<void> {
  return saveIndexFor(currentLibrary(), books);
}

/** Toglie l'indice dalla memoria (libreria eliminata). */
export function dropIndexCache(id: string): void {
  indexCaches.delete(id);
}

/** Impostazioni globali, senza adattarle alla libreria corrente. */
async function loadGlobalSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache;
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
    settingsCache = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  // Con LIBRARY_ROOT nell'ambiente vale sempre quella, ignorando il valore salvato.
  if (LIBRARY_ROOT_LOCKED) settingsCache.libraryRoot = DEFAULT_LIBRARY_ROOT;
  return settingsCache;
}

/** Impostazioni gia' in memoria (o i valori predefiniti): per chi non puo' aspettare. */
export function peekSettings(): AppSettings {
  return settingsCache ?? DEFAULT_SETTINGS;
}

/**
 * Impostazioni valide per la libreria corrente: quelle globali (chiavi API,
 * Jellyfin, tema...) con cartella e nome della libreria aperta.
 */
export async function loadSettings(): Promise<AppSettings> {
  const global = await loadGlobalSettings();
  const library = currentLibrary();
  if (library.isMain) return global;
  return { ...global, libraryRoot: library.root, libraryName: library.name };
}

/** Salva nel file globale senza filtrare nulla (anche cartella e nome della principale). */
export async function saveGlobalSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadGlobalSettings();
  settingsCache = { ...current, ...patch };
  if (LIBRARY_ROOT_LOCKED) settingsCache.libraryRoot = DEFAULT_LIBRARY_ROOT;
  const snapshot = settingsCache;
  await queue(() => writeJsonAtomic(SETTINGS_FILE, snapshot));
  return snapshot;
}

/**
 * Da una libreria diversa dalla principale cartella e nome non finiscono nel
 * file globale: appartengono alla principale (il nome si cambia con renameLibrary).
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (!currentLibrary().isMain) {
    const { libraryRoot: _root, libraryName: _name, ...rest } = patch;
    patch = rest;
  }
  await saveGlobalSettings(patch);
  return loadSettings();
}

export function toSummary(book: BookMeta): BookSummary {
  return {
    id: book.id,
    kind: book.kind,
    editions: book.editions,
    title: book.title,
    subtitle: book.subtitle,
    authors: book.authors,
    series: book.series,
    seriesIndex: book.seriesIndex,
    coverFile: book.coverFile,
    folder: book.folder,
    format: book.format,
    fandom: book.fandom,
    tags: book.tags,
    rating: book.rating,
    fanRating: book.fanRating,
    status: book.status,
    wordCount: book.wordCount,
    pageCount: book.pageCount,
    publishedDate: book.publishedDate,
    dateAdded: book.dateAdded,
    dateModified: book.dateModified,
    lastRead: book.lastRead,
    readingStatus: book.readingStatus,
    readingProgress: book.readingProgress,
    dateFinished: book.dateFinished,
    dateStarted: book.dateStarted ?? null,
    favorite: book.favorite,
    publisher: book.publisher,
    language: book.language,
    description: book.description,
    isbn: book.isbn,
    ao3Url: book.ao3Url ?? '',
    fanficUpdate: book.fanficUpdate ?? null,
  };
}
