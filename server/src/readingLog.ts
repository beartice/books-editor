import fsp from 'node:fs/promises';
import path from 'node:path';
import { currentLibrary, type LibraryInfo } from './libraries.js';
import { loadIndexFor, writeJsonAtomic } from './store.js';
import type { BookMeta } from '../../shared/types.js';

// Registro delle giornate di lettura: un file per libreria (`reading-log.json`).
// Apple Books conserva solo l'ULTIMA data di utilizzo di ogni libro, quindi lo storico
// si costruisce nel tempo: ogni giorno visto resta nel registro anche dopo che Apple
// passa a una data successiva. NON usare `readingProgressUpdatedAt`: dopo una
// sincronizzazione vale «adesso» per molte schede insieme e non indica una lettura.

export type ReadingSource =
  | 'apple-engaged'
  | 'apple-opened'
  | 'reader'
  | 'started'
  | 'finished'
  | 'highlight';

export interface ReadingLog {
  version: 1;
  /** AAAA-MM-GG (fuso del server) -> id del libro -> fonti che lo hanno registrato. */
  days: Record<string, Record<string, { sources: ReadingSource[] }>>;
}

export interface ReadingEvent {
  day: string;
  bookId: string;
  source: ReadingSource;
}

type LogTarget = Pick<LibraryInfo, 'id' | 'dataDir'>;

const caches = new Map<string, ReadingLog>();
let writeChain: Promise<unknown> = Promise.resolve();

function logFile(library: LogTarget): string {
  return path.join(library.dataDir, 'reading-log.json');
}

/**
 * Giorno (AAAA-MM-GG) nel fuso del server (`TZ`) di una data ISO; una data di soli
 * giorni resta com'e'. null se non leggibile.
 */
export function localDayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Registro della libreria (in memoria o dal file); null se non esiste ancora. */
async function readLog(library: LogTarget): Promise<ReadingLog | null> {
  const cached = caches.get(library.id);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await fsp.readFile(logFile(library), 'utf8')) as ReadingLog;
    if (!parsed || typeof parsed.days !== 'object' || parsed.days === null) return null;
    const log: ReadingLog = { version: 1, days: parsed.days };
    caches.set(library.id, log);
    return log;
  } catch {
    return null;
  }
}

function addEvents(log: ReadingLog, events: ReadingEvent[]): boolean {
  let changed = false;
  for (const { day, bookId, source } of events) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const books = (log.days[day] ??= {});
    const entry = (books[bookId] ??= { sources: [] });
    if (!entry.sources.includes(source)) {
      entry.sources.push(source);
      entry.sources.sort();
      changed = true;
    }
  }
  return changed;
}

function saveLog(library: LogTarget, log: ReadingLog): Promise<void> {
  const write = () => writeJsonAtomic(logFile(library), log);
  const next = writeChain.then(write, write);
  writeChain = next.catch(() => undefined);
  return next;
}

/** Giorni di lettura che si deducono da una scheda (per la ricostruzione del passato). */
export function eventsFromBook(book: BookMeta): ReadingEvent[] {
  const events: ReadingEvent[] = [];
  const add = (value: string | null | undefined, source: ReadingSource) => {
    const day = localDayOf(value);
    if (day) events.push({ day, bookId: book.id, source });
  };
  add(book.dateStarted, 'started');
  add(book.dateFinished, 'finished');
  add(book.appleDates?.lastEngagedAt, 'apple-engaged');
  // La prima apertura vale solo se non e' successiva alla fine della lettura.
  const first = localDayOf(book.appleDates?.firstOpenedAt);
  const end = localDayOf(book.dateFinished);
  if (first && (!end || first <= end)) events.push({ day: first, bookId: book.id, source: 'apple-opened' });
  for (const position of Object.values(book.readingPositions ?? {})) add(position?.updatedAt, 'reader');
  for (const highlight of book.highlights ?? []) add(highlight.createdAt, 'highlight');
  return events;
}

/** Aggiunge al registro i giorni dedotti dalle schede (non toglie nulla) e lo salva. */
export async function rebuildReadingLog(
  books: BookMeta[],
  library: LogTarget = currentLibrary(),
): Promise<ReadingLog> {
  const log = (await readLog(library)) ?? { version: 1 as const, days: {} };
  caches.set(library.id, log);
  addEvents(log, books.flatMap(eventsFromBook));
  await saveLog(library, log);
  return log;
}

/** Il registro della libreria; se il file manca lo ricostruisce dalle schede. */
export async function ensureReadingLog(
  books: BookMeta[],
  library: LogTarget = currentLibrary(),
): Promise<ReadingLog> {
  return (await readLog(library)) ?? rebuildReadingLog(books, library);
}

/**
 * Registra una serie di giornate di lettura con una sola scrittura. Idempotente: se
 * non c'e' nulla di nuovo il file non viene toccato. Un errore di scrittura non
 * deve mai far fallire l'operazione che lo ha causato.
 */
export async function recordReadingDays(
  events: ReadingEvent[],
  library: LogTarget = currentLibrary(),
): Promise<void> {
  if (!events.length) return;
  try {
    // Senza registro si parte dal passato, altrimenti il primo evento lo "congelerebbe" vuoto.
    const log = await ensureReadingLog(await loadIndexFor(library), library);
    if (addEvents(log, events)) await saveLog(library, log);
  } catch (error) {
    console.warn('[reading-log] giornate non registrate:', (error as Error).message);
  }
}
