import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BookMeta, MonthlyPickResult } from '../../shared/types.js';
import { currentLibrary, visibleBooks } from './libraries.js';
import { groupBySeries, isLowestUnreadVolume } from './recommendations.js';
import { localDay } from './readingStats.js';
import { loadIndex, loadSettings, writeJsonAtomic } from './store.js';

/*
 * «Libro del mese»: ogni mese un libro non letto pescato a caso fra quelli in libreria.
 * Lo stato (mese, libro, scartati, storico) sta in `monthly-pick.json` nella cartella dati
 * della libreria, quindi ogni libreria ha il suo.
 */

const HISTORY_MAX = 12;
/** Un libro uscito negli ultimi mesi non torna. */
const NO_REPEAT_MONTHS = 6;
/** Mesi precedenti mostrati nella risposta. */
const HISTORY_SHOWN = 3;

interface PickState {
  month: string;
  bookId: string | null;
  hidden: boolean;
  skipped: string[];
  history: { month: string; bookId: string }[];
}

export class MonthlyPickError extends Error {}

const emptyState = (): PickState => ({ month: '', bookId: null, hidden: false, skipped: [], history: [] });

function stateFile(): string {
  return path.join(currentLibrary().dataDir, 'monthly-pick.json');
}

async function loadState(): Promise<PickState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(stateFile(), 'utf8')) as Partial<PickState>;
    return {
      month: typeof parsed.month === 'string' ? parsed.month : '',
      bookId: typeof parsed.bookId === 'string' ? parsed.bookId : null,
      hidden: parsed.hidden === true,
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter((id) => typeof id === 'string') : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return emptyState();
  }
}

/** Una sola operazione alla volta: due richieste ravvicinate non pescano due libri. */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.catch(() => undefined);
  return next;
}

/** Mese `AAAA-MM` di sei mesi prima (solo per escludere i libri usciti da poco). */
function monthsAgo(month: string, count: number): string {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) - count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** Libri pescabili: non letti, non iniziati, non nascosti, primo volume non letto della serie. */
function candidates(books: BookMeta[], state: PickState, month: string): BookMeta[] {
  const bySeries = groupBySeries(books);
  const recent = new Set(
    state.history.filter((entry) => entry.month > monthsAgo(month, NO_REPEAT_MONTHS)).map((entry) => entry.bookId),
  );
  const skipped = new Set(state.skipped);
  return books.filter(
    (book) =>
      book.kind === 'book' &&
      book.readingStatus === 'unread' &&
      !book.readingProgress &&
      !book.recommendationDismissed &&
      isLowestUnreadVolume(book, bySeries) &&
      !skipped.has(book.id) &&
      !recent.has(book.id),
  );
}

function pickRandom(list: BookMeta[]): string | null {
  return list.length ? list[Math.floor(Math.random() * list.length)].id : null;
}

function statusOf(book: BookMeta): 'unread' | 'reading' | 'finished' {
  if (book.readingStatus === 'read' || book.readingStatus === 'reread') return 'finished';
  if (book.readingStatus === 'reading' || (book.readingProgress ?? 0) > 0) return 'reading';
  return 'unread';
}

async function visible(): Promise<BookMeta[]> {
  return visibleBooks(currentLibrary(), await loadIndex());
}

/** Porta lo stato al mese corrente e sceglie il libro, se serve. Restituisce true se lo stato e' cambiato. */
function ensure(state: PickState, books: BookMeta[], month: string): boolean {
  let changed = false;
  if (state.month !== month) {
    if (state.month && state.bookId) {
      state.history = [{ month: state.month, bookId: state.bookId }, ...state.history].slice(0, HISTORY_MAX);
    }
    state.month = month;
    state.bookId = null;
    state.skipped = [];
    state.hidden = false;
    changed = true;
  }
  const current = state.bookId ? books.find((book) => book.id === state.bookId) : undefined;
  // Il libro resta anche se iniziato o finito; cambia solo se e' sparito o nascosto dai suggerimenti.
  if (!current || current.recommendationDismissed) {
    const next = pickRandom(candidates(books, state, month));
    if (next !== state.bookId) {
      state.bookId = next;
      changed = true;
    }
  }
  return changed;
}

async function describe(state: PickState, books: BookMeta[], now: Date): Promise<MonthlyPickResult> {
  const settings = await loadSettings();
  const byId = new Map(books.map((book) => [book.id, book]));
  const [year, number] = state.month.split('-').map(Number);
  const lastDay = new Date(year, number, 0).getDate();
  const daysLeft = lastDay - now.getDate() + 1;
  const book = state.bookId ? byId.get(state.bookId) : undefined;
  const status = book ? statusOf(book) : null;
  // Il totale da cui si pesca: anche i libri gia' scartati nel mese contano.
  const pool = candidates(books, { ...state, skipped: [] }, state.month);

  let estimate: MonthlyPickResult['estimate'] = null;
  if (book && status !== 'finished' && book.wordCount && book.wordCount > 0 && settings.wordsPerHour > 0) {
    // Come nelle statistiche, l'impostazione «parole per ora» vale in realta' parole al minuto.
    const total = book.wordCount / settings.wordsPerHour;
    const progress = Math.min(100, Math.max(0, book.readingProgress ?? 0));
    const minutes = Math.round(total * (1 - progress / 100));
    estimate = { minutes, perDay: Math.round(minutes / Math.max(1, daysLeft)) };
  }

  return {
    month: state.month,
    daysLeft,
    book: book && status ? { id: book.id, status } : null,
    hidden: state.hidden,
    poolSize: pool.length + (book && !pool.some((item) => item.id === book.id) ? 1 : 0),
    estimate,
    history: state.history.slice(0, HISTORY_SHOWN).map((entry) => {
      const past = byId.get(entry.bookId);
      const finishedOn = past?.dateFinished ?? '';
      return {
        month: entry.month,
        bookId: entry.bookId,
        finished: Boolean(
          past && statusOf(past) === 'finished' && finishedOn.slice(0, 7) >= entry.month,
        ),
      };
    }),
  };
}

/** Il libro del mese corrente (lo pesca se il mese e' cambiato). */
export function getMonthlyPick(now = new Date()): Promise<MonthlyPickResult> {
  return serialized(async () => {
    const books = await visible();
    const state = await loadState();
    if (ensure(state, books, localDay(now).slice(0, 7))) await writeJsonAtomic(stateFile(), state);
    return describe(state, books, now);
  });
}

/** Scarta il libro attuale e ne pesca un altro. */
export function rerollMonthlyPick(now = new Date()): Promise<MonthlyPickResult> {
  return serialized(async () => {
    const books = await visible();
    const state = await loadState();
    const month = localDay(now).slice(0, 7);
    if (ensure(state, books, month)) await writeJsonAtomic(stateFile(), state);
    const next: PickState = { ...state, skipped: state.bookId ? [...state.skipped, state.bookId] : state.skipped };
    const id = pickRandom(candidates(books, next, month));
    if (!id) throw new MonthlyPickError('Non ci sono altri libri da pescare');
    next.bookId = id;
    await writeJsonAtomic(stateFile(), next);
    return describe(next, books, now);
  });
}

/** Nasconde o mostra la fascia fino a fine mese. */
export function setMonthlyPickHidden(hidden: boolean, now = new Date()): Promise<MonthlyPickResult> {
  return serialized(async () => {
    const books = await visible();
    const state = await loadState();
    ensure(state, books, localDay(now).slice(0, 7));
    state.hidden = hidden;
    await writeJsonAtomic(stateFile(), state);
    return describe(state, books, now);
  });
}
