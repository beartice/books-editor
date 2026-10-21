import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DEFAULT_LIBRARY_ROOT, LIBRARY_ROOT_LOCKED, ensureDir } from './config.js';
import type { AppSettings, BookMeta, BookSummary } from '../../shared/types.js';

const INDEX_FILE = path.join(DATA_DIR, 'index.json');
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

let indexCache: BookMeta[] | null = null;
let settingsCache: AppSettings | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

/** Scrittura atomica: file temporaneo + rename, evita indici corrotti. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
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

export async function loadIndex(): Promise<BookMeta[]> {
  if (indexCache) return indexCache;
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw) as IndexFile;
    indexCache = Array.isArray(parsed.books) ? parsed.books : [];
  } catch {
    indexCache = [];
  }
  return indexCache;
}

export async function saveIndex(books: BookMeta[]): Promise<void> {
  indexCache = books;
  const payload: IndexFile = { version: 1, books };
  await queue(() => writeJsonAtomic(INDEX_FILE, payload));
}

export async function loadSettings(): Promise<AppSettings> {
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

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  settingsCache = { ...current, ...patch };
  if (LIBRARY_ROOT_LOCKED) settingsCache.libraryRoot = DEFAULT_LIBRARY_ROOT;
  await queue(() => writeJsonAtomic(SETTINGS_FILE, settingsCache));
  return settingsCache;
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
    favorite: book.favorite,
    publisher: book.publisher,
    language: book.language,
    description: book.description,
    isbn: book.isbn,
    ao3Url: book.ao3Url ?? '',
  };
}
