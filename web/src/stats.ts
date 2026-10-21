import type { BookEdition, BookSummary } from '@shared/types';
import { bookGenres } from './genres';

/** Anno scelto nel selettore: un anno oppure tutti. */
export type StatsYear = number | 'all';

export const RATING_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
export const MIN_RATED_FOR_GENRE_AVERAGE = 3;

const MONTH_LABELS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

export function isRead(book: BookSummary): boolean {
  return book.readingStatus === 'read' || book.readingStatus === 'reread';
}

/** Voto valido (0,5 - 5), altrimenti null. */
function ratingOf(book: BookSummary): number | null {
  const value = book.rating;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Anno e mese (1-12) da una data AAAA-MM-GG; null se non leggibile. */
function parseFinished(value: string | null): { year: number; month: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(match[1]), month };
}

/** Anni presenti in `dateFinished`, dal piu' recente. */
export function finishedYears(books: BookSummary[]): number[] {
  const years = new Set<number>();
  for (const book of books) {
    const parsed = parseFinished(book.dateFinished);
    if (parsed) years.add(parsed.year);
  }
  return [...years].sort((a, b) => b - a);
}

export interface StatsTiles {
  read: number;
  reading: number;
  unread: number;
  dnf: number;
  reread: number;
  /** Media dei voti, null se nessun libro e' votato. */
  averageRating: number | null;
  ratedCount: number;
  wordsRead: number;
  books: number;
  fanfics: number;
  readInYear: number;
}

export function computeTiles(books: BookSummary[], year: StatsYear): StatsTiles {
  const ratings = books.map(ratingOf).filter((value): value is number => value !== null);
  let wordsRead = 0;
  let readInYear = 0;
  const tiles: StatsTiles = {
    read: 0,
    reading: 0,
    unread: 0,
    dnf: 0,
    reread: 0,
    averageRating: average(ratings),
    ratedCount: ratings.length,
    wordsRead: 0,
    books: 0,
    fanfics: 0,
    readInYear: 0,
  };
  for (const book of books) {
    if (book.kind === 'fanfic') tiles.fanfics += 1;
    else tiles.books += 1;
    if (book.readingStatus === 'reading') tiles.reading += 1;
    else if (book.readingStatus === 'unread') tiles.unread += 1;
    else if (book.readingStatus === 'dnf') tiles.dnf += 1;
    if (book.readingStatus === 'reread') tiles.reread += 1;
    if (!isRead(book)) continue;
    tiles.read += 1;
    wordsRead += book.wordCount ?? 0;
    const finished = parseFinished(book.dateFinished);
    if (finished && (year === 'all' || finished.year === year)) readInYear += 1;
  }
  tiles.wordsRead = wordsRead;
  tiles.readInYear = readInYear;
  return tiles;
}

export interface TimePoint {
  key: string;
  label: string;
  value: number;
}

export interface ReadingTimeline {
  points: TimePoint[];
  /** Letti senza data di fine (non finiscono nel grafico). */
  undated: number;
}

export function computeTimeline(books: BookSummary[], year: StatsYear): ReadingTimeline {
  let undated = 0;
  const byMonth = new Array<number>(12).fill(0);
  const byYear = new Map<number, number>();
  for (const book of books) {
    if (!isRead(book)) continue;
    const finished = parseFinished(book.dateFinished);
    if (!finished) {
      undated += 1;
      continue;
    }
    byYear.set(finished.year, (byYear.get(finished.year) ?? 0) + 1);
    if (year !== 'all' && finished.year === year) byMonth[finished.month - 1] += 1;
  }

  if (year !== 'all') {
    return {
      points: byMonth.map((value, index) => ({
        key: `${year}-${String(index + 1).padStart(2, '0')}`,
        label: MONTH_LABELS[index],
        value,
      })),
      undated,
    };
  }
  if (byYear.size === 0) return { points: [], undated };
  const years = [...byYear.keys()];
  const first = Math.min(...years);
  const last = Math.max(...years);
  const points: TimePoint[] = [];
  for (let current = first; current <= last; current += 1) {
    points.push({ key: String(current), label: String(current), value: byYear.get(current) ?? 0 });
  }
  return { points, undated };
}

/** Distribuzione dei voti su 10 classi (0,5 ... 5), su tutti i libri votati. */
export function computeRatingDistribution(books: BookSummary[]): TimePoint[] {
  const counts = new Array<number>(RATING_STEPS.length).fill(0);
  for (const book of books) {
    const rating = ratingOf(book);
    if (rating === null) continue;
    const index = Math.min(RATING_STEPS.length - 1, Math.max(0, Math.round(rating * 2) - 1));
    counts[index] += 1;
  }
  return RATING_STEPS.map((step, index) => ({
    key: String(step),
    label: step % 1 === 0 ? String(step) : formatRating(step, 1),
    value: counts[index],
  }));
}

export interface GenreStat {
  genre: string;
  count: number;
  read: number;
  rated: number;
  averageRating: number | null;
}

/** Tutti i generi con almeno un libro, dal piu' numeroso. */
export function computeGenreStats(books: BookSummary[]): GenreStat[] {
  const map = new Map<string, { count: number; read: number; ratings: number[] }>();
  for (const book of books) {
    const rating = ratingOf(book);
    for (const genre of bookGenres(book.tags)) {
      const entry = map.get(genre) ?? { count: 0, read: 0, ratings: [] };
      entry.count += 1;
      if (isRead(book)) entry.read += 1;
      if (rating !== null) entry.ratings.push(rating);
      map.set(genre, entry);
    }
  }
  return [...map.entries()]
    .map(([genre, entry]) => ({
      genre,
      count: entry.count,
      read: entry.read,
      rated: entry.ratings.length,
      averageRating: average(entry.ratings),
    }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre, 'it'));
}

export function topGenres(stats: GenreStat[], n = 12): GenreStat[] {
  return stats.slice(0, n);
}

/** Generi con abbastanza libri votati, dal voto medio piu' alto. */
export function ratedGenres(stats: GenreStat[]): GenreStat[] {
  return stats
    .filter((item) => item.rated >= MIN_RATED_FOR_GENRE_AVERAGE && item.averageRating !== null)
    .sort(
      (a, b) =>
        (b.averageRating ?? 0) - (a.averageRating ?? 0) ||
        b.rated - a.rated ||
        a.genre.localeCompare(b.genre, 'it'),
    );
}

export interface CountStat {
  name: string;
  count: number;
}

function topCounts(counts: Map<string, number>, n: number): CountStat[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'it'))
    .slice(0, n);
}

/** Autori con piu' libri letti. */
export function computeTopAuthors(books: BookSummary[], n = 10): CountStat[] {
  const counts = new Map<string, number>();
  for (const book of books) {
    if (!isRead(book)) continue;
    for (const author of new Set(book.authors.map((name) => name.trim()).filter(Boolean))) {
      counts.set(author, (counts.get(author) ?? 0) + 1);
    }
  }
  return topCounts(counts, n);
}

/** Fandom piu' presenti tra le fanfic della libreria. */
export function computeTopFandoms(books: BookSummary[], n = 10): CountStat[] {
  const counts = new Map<string, number>();
  for (const book of books) {
    const fandom = book.fandom?.trim();
    if (book.kind !== 'fanfic' || !fandom) continue;
    counts.set(fandom, (counts.get(fandom) ?? 0) + 1);
  }
  return topCounts(counts, n);
}

// Codici lingua a tre lettere (e varianti regionali) riportati al codice a due.
const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en',
  ita: 'it',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  spa: 'es',
  por: 'pt',
  dut: 'nl',
  nld: 'nl',
  rus: 'ru',
  pol: 'pl',
  tur: 'tr',
  heb: 'he',
  cat: 'ca',
  hun: 'hu',
  rum: 'ro',
  ron: 'ro',
  ukr: 'uk',
  jpn: 'ja',
  chi: 'zh',
  zho: 'zh',
  lat: 'la',
  gre: 'el',
  ell: 'el',
};

export function normalizeLanguage(value: string | undefined): string {
  const code = (value ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_ALIASES[code] ?? code;
}

/** Codici lingua (normalizzati) dell'opera: principale piu' edizioni, senza doppioni. */
export function bookLanguages(book: BookSummary): string[] {
  const editions: BookEdition[] = book.editions ?? [];
  const codes = new Set<string>();
  for (const code of [book.language, ...editions.map((edition) => edition.language)]) {
    const normalized = normalizeLanguage(code);
    if (normalized) codes.add(normalized);
  }
  return [...codes];
}

/** Libri per lingua; i libri senza lingua non compaiono. */
export function computeLanguages(books: BookSummary[], n = 10): CountStat[] {
  const counts = new Map<string, number>();
  for (const book of books) {
    for (const code of bookLanguages(book)) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return topCounts(counts, n);
}

/** Voto con la virgola («3,9»). */
export function formatRating(value: number, digits = 1): string {
  return value.toFixed(digits).replace('.', ',');
}

const compactFormat = new Intl.NumberFormat('it-IT', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Numero compatto in italiano (1,2 mila / 3,4 Mln). */
export function formatCompact(value: number): string {
  return compactFormat.format(value);
}
