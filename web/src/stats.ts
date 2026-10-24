import type { BookEdition, BookSummary } from '@shared/types';
import { bookGenres } from './genres';

export const MIN_RATED_FOR_GENRE_AVERAGE = 3;

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
