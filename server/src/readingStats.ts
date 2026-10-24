import { bookGenres } from '../../shared/genres.js';
import { localDayOf, type ReadingLog } from './readingLog.js';
import type {
  BookMeta,
  KindSplit,
  ReadingStats,
  ReadingStatsBucket,
  ReadingStatsMonth,
  ReadingStatsRead,
} from '../../shared/types.js';

// Statistiche di lettura: sono calcolate qui perche' le sottolineature (con la loro
// data) non stanno nei riepiloghi `BookSummary` che arrivano all'interfaccia.

const DAY_MS = 86400000;
const RATING_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

/** Oggi (AAAA-MM-GG, ora del server). */
export function localDay(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTime(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

function fromTime(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function dayDiff(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY_MS);
}

/** Giorno (AAAA-MM-GG) da una data ISO o gia' di soli giorni, null se non leggibile. */
function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return match[0];
}

function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** Mesi (AAAA-MM) da quello della prima data a quello della seconda, estremi compresi. */
function monthsBetween(from: string, to: string): string[] {
  const result: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const lastYear = Number(to.slice(0, 4));
  const lastMonth = Number(to.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    result.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

function lastDayOfMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return fromTime(Date.UTC(year, month, 0));
}

/** Finestra dei grafici: l'anno scelto (fino a fine mese se e' in corso) o gli ultimi 12 mesi. */
function windowFor(year: number | 'all', today: string): { from: string; to: string; today: string } {
  const currentYear = Number(today.slice(0, 4));
  if (year === 'all') {
    const from = fromTime(Date.UTC(currentYear, Number(today.slice(5, 7)) - 12, 1));
    return { from, to: lastDayOfMonth(today), today };
  }
  const from = `${year}-01-01`;
  const to = year === currentYear ? lastDayOfMonth(today) : `${year}-12-31`;
  return { from, to, today };
}

function isRead(book: BookMeta): boolean {
  return book.readingStatus === 'read' || book.readingStatus === 'reread';
}

function ratingOf(book: BookMeta): number | null {
  const value = book.rating;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function emptySplit(): KindSplit {
  return { total: 0, books: 0, fanfics: 0 };
}

function addToSplit(split: KindSplit, book: Pick<BookMeta, 'kind'>): void {
  split.total += 1;
  if (book.kind === 'fanfic') split.fanfics += 1;
  else split.books += 1;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function byCountThenName<T extends { count: number }>(name: (item: T) => string) {
  return (a: T, b: T) => b.count - a.count || name(a).localeCompare(name(b), 'it');
}

/**
 * Calcola le statistiche per `books` (gia' filtrati con `visibleBooks`).
 * `wordsPerMinute` e' il valore dell'impostazione «parole per ora di lettura»: come in
 * tutta l'interfaccia (`formatDuration`) e' in realta' un ritmo al minuto (230 = 13.800
 * parole all'ora), quindi le ore sono parole / (valore * 60).
 */
export function computeReadingStats(
  books: BookMeta[],
  year: number | 'all',
  wordsPerMinute: number,
  now = new Date(),
  log: ReadingLog = { version: 1, days: {} },
): ReadingStats {
  const today = localDay(now);
  const window = windowFor(year, today);
  const inWindow = (day: string | null): day is string =>
    day !== null && day >= window.from && day <= window.to;
  const finishedDay = (book: BookMeta) => dayOf(book.dateFinished);

  // Stato attuale della libreria.
  const total = emptySplit();
  const read = emptySplit();
  const reading = emptySplit();
  const dnf = emptySplit();
  const unread = emptySplit();
  const stateIds = { read: [] as string[], reading: [] as string[], dnf: [] as string[], unread: [] as string[] };
  for (const book of books) {
    addToSplit(total, book);
    if (isRead(book)) {
      addToSplit(read, book);
      stateIds.read.push(book.id);
    } else if (book.readingStatus === 'reading') {
      addToSplit(reading, book);
      stateIds.reading.push(book.id);
    } else if (book.readingStatus === 'dnf') {
      addToSplit(dnf, book);
      stateIds.dnf.push(book.id);
    } else {
      addToSplit(unread, book);
      stateIds.unread.push(book.id);
    }
  }

  // Opere lette del periodo: con un anno scelto servono la data di fine in quell'anno.
  const readBooks = books.filter(isRead);
  const periodRead = readBooks.filter((book) => {
    if (year === 'all') return true;
    return finishedDay(book)?.startsWith(`${year}-`) ?? false;
  });
  const periodSplit = emptySplit();
  let reread = 0;
  let words = 0;
  for (const book of periodRead) {
    addToSplit(periodSplit, book);
    if (book.readingStatus === 'reread') reread += 1;
    words += book.wordCount ?? 0;
  }
  // Voti: con `all` tutte le opere votate (anche non lette), con un anno quelle lette in quell'anno.
  const ratedBooks = (year === 'all' ? books : periodRead).filter((book) => ratingOf(book) !== null);
  const ratings = ratedBooks.map((book) => ratingOf(book) as number);
  const ratingIds: string[][] = RATING_STEPS.map(() => []);
  for (const book of ratedBooks) {
    const rating = ratingOf(book) as number;
    ratingIds[Math.min(RATING_STEPS.length - 1, Math.max(0, Math.round(rating * 2) - 1))].push(book.id);
  }
  const fiveStarIds = ratedBooks.filter((book) => (ratingOf(book) as number) >= 5).map((book) => book.id);

  // Letture per anno di fine (sempre su tutto il tempo), senza buchi.
  const yearCounts = new Map<number, { books: number; fanfics: number; bookIds: string[]; fanficIds: string[] }>();
  let withFinishDate = 0;
  for (const book of readBooks) {
    const day = finishedDay(book);
    if (!day) continue;
    withFinishDate += 1;
    const key = Number(day.slice(0, 4));
    const entry = yearCounts.get(key) ?? { books: 0, fanfics: 0, bookIds: [], fanficIds: [] };
    if (book.kind === 'fanfic') {
      entry.fanfics += 1;
      entry.fanficIds.push(book.id);
    } else {
      entry.books += 1;
      entry.bookIds.push(book.id);
    }
    yearCounts.set(key, entry);
  }
  const byYear: ReadingStats['byYear'] = [];
  if (yearCounts.size) {
    const years = [...yearCounts.keys()];
    for (let current = Math.min(...years); current <= Math.max(...years); current += 1) {
      byYear.push({
        year: current,
        ...(yearCounts.get(current) ?? { books: 0, fanfics: 0, bookIds: [], fanficIds: [] }),
      });
    }
  }

  // Letture finite nella finestra, con l'inizio quando e' noto.
  const items: ReadingStatsRead[] = [];
  for (const book of readBooks) {
    const end = finishedDay(book);
    if (!inWindow(end)) continue;
    let start = dayOf(book.dateStarted);
    if (start && start > end) start = null;
    items.push({
      id: book.id,
      title: book.title || 'Senza titolo',
      kind: book.kind,
      start,
      end,
      days: start ? dayDiff(start, end) : null,
      rating: ratingOf(book),
    });
  }
  items.sort((a, b) => a.end.localeCompare(b.end) || a.title.localeCompare(b.title, 'it'));
  const readsCount = emptySplit();
  for (const item of items) addToSplit(readsCount, item);
  const durations = items.map((item) => item.days).filter((value): value is number => value !== null);
  const bucketOf = (key: ReadingStatsBucket['key'], label: string, test: (days: number) => boolean) => {
    const ids = items.filter((item) => item.days !== null && test(item.days)).map((item) => item.id);
    return { key, label, count: ids.length, ids };
  };
  const buckets: ReadingStatsBucket[] = [
    bucketOf('same', 'Stesso giorno', (d) => d === 0),
    bucketOf('short', '1–2 giorni', (d) => d >= 1 && d <= 2),
    bucketOf('week', '3–7 giorni', (d) => d >= 3 && d <= 7),
    bucketOf('month', '8–30 giorni', (d) => d >= 8 && d <= 30),
    bucketOf('long', 'Oltre un mese', (d) => d > 30),
  ];
  let longest: ReadingStatsRead | null = null;
  for (const item of items) {
    if (item.days !== null && (longest === null || item.days > (longest.days ?? -1))) longest = item;
  }

  // Sottolineature di tutti i libri, per giorno (nella finestra) e per libro.
  const highlightsByDay: Record<string, number> = {};
  // Sottolineature per giorno e per libro (nella finestra) e libri sottolineati per mese.
  const dayBookHighlights = new Map<string, Map<string, number>>();
  const monthBookIds = new Map<string, Set<string>>();
  const perBook = new Map<string, { id: string; title: string; count: number }>();
  for (const book of books) {
    for (const highlight of book.highlights ?? []) {
      // Giorno nel fuso del server, come il registro delle giornate di lettura.
      const day = localDayOf(highlight.createdAt);
      if (inWindow(day)) {
        highlightsByDay[day] = (highlightsByDay[day] ?? 0) + 1;
        const perDay = dayBookHighlights.get(day) ?? new Map<string, number>();
        perDay.set(book.id, (perDay.get(book.id) ?? 0) + 1);
        dayBookHighlights.set(day, perDay);
        const inMonthIds = monthBookIds.get(monthOf(day)) ?? new Set<string>();
        inMonthIds.add(book.id);
        monthBookIds.set(monthOf(day), inMonthIds);
      }
      // Con un anno contano solo quelle fatte nell'anno; con `all` tutte, anche senza data.
      if (year !== 'all' && !(day && day.startsWith(`${year}-`))) continue;
      const entry = perBook.get(book.id) ?? { id: book.id, title: book.title || 'Senza titolo', count: 0 };
      entry.count += 1;
      perBook.set(book.id, entry);
    }
  }

  // Giornate di lettura: registro (solo libri visibili) piu' i giorni delle sottolineature.
  const titles = new Map(books.map((book) => [book.id, book.title || 'Senza titolo']));
  const readingDays: ReadingStats['readingDays'] = {};
  const dayEntry = (day: string) => (readingDays[day] ??= { books: [], highlights: 0 });
  const addBook = (day: string, id: string) => {
    const entry = dayEntry(day);
    if (!entry.books.some((item) => item.id === id)) {
      entry.books.push({ id, title: titles.get(id) ?? '', highlights: dayBookHighlights.get(day)?.get(id) ?? 0 });
    }
  };
  for (const [day, logged] of Object.entries(log.days)) {
    if (!inWindow(day) || day > today) continue;
    for (const id of Object.keys(logged)) if (titles.has(id)) addBook(day, id);
  }
  for (const book of books) {
    for (const highlight of book.highlights ?? []) {
      const day = localDayOf(highlight.createdAt);
      if (inWindow(day)) addBook(day, book.id);
    }
  }
  for (const [day, count] of Object.entries(highlightsByDay)) dayEntry(day).highlights = count;
  for (const [day, entry] of Object.entries(readingDays)) {
    if (!entry.books.length && !entry.highlights) delete readingDays[day];
    else entry.books.sort((a, b) => a.title.localeCompare(b.title, 'it'));
  }

  const months = monthsBetween(window.from, window.to);
  const monthStats = new Map<string, { count: number; days: number }>(
    months.map((month) => [month, { count: 0, days: 0 }]),
  );
  let highlightsTotal = 0;
  let recordDay: { date: string; count: number } | null = null;
  for (const [day, count] of Object.entries(highlightsByDay)) {
    highlightsTotal += count;
    const entry = monthStats.get(monthOf(day));
    if (entry) {
      entry.count += count;
      entry.days += 1;
    }
    if (!recordDay || count > recordDay.count || (count === recordDay.count && day < recordDay.date)) {
      recordDay = { date: day, count };
    }
  }
  const highlightsByMonth: ReadingStatsMonth[] = months.map((month) => ({
    month,
    ...(monthStats.get(month) ?? { count: 0, days: 0 }),
    ids: [...(monthBookIds.get(month) ?? [])],
  }));
  let busiestMonth: ReadingStatsMonth | null = null;
  for (const entry of highlightsByMonth) {
    if (entry.count > 0 && (busiestMonth === null || entry.count > busiestMonth.count)) busiestMonth = entry;
  }

  // Autori e generi delle opere lette nel periodo.
  const authorBooks = new Map<string, string[]>();
  const genreBooks = new Map<string, string[]>();
  const pushId = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const book of periodRead) {
    for (const author of new Set(book.authors.map((name) => name.trim()).filter(Boolean))) {
      pushId(authorBooks, author, book.id);
    }
    for (const genre of bookGenres(book.tags)) pushId(genreBooks, genre, book.id);
  }

  // In lettura: i piu' avanzati.
  const inProgress = books
    .filter((book) => book.readingStatus === 'reading')
    .map((book) => ({
      id: book.id,
      title: book.title || 'Senza titolo',
      kind: book.kind,
      progress: Math.round(book.readingProgress ?? 0),
    }))
    .filter((item) => item.progress > 0)
    .sort((a, b) => b.progress - a.progress || a.title.localeCompare(b.title, 'it'));

  // Aggiunte alla libreria: data di Apple Books se c'e', altrimenti quella di inserimento.
  const addedMonths = new Map<string, string[]>(months.map((month) => [month, []]));
  let addedTotal = 0;
  for (const book of books) {
    const day = dayOf(book.appleDates?.addedAt) ?? dayOf(book.dateAdded);
    if (!inWindow(day)) continue;
    const month = monthOf(day);
    pushId(addedMonths, month, book.id);
    addedTotal += 1;
  }
  const addedByMonth = months.map((month) => {
    const ids = addedMonths.get(month) ?? [];
    return { month, count: ids.length, ids };
  });
  let addedBusiest: { month: string; count: number } | null = null;
  for (const entry of addedByMonth) {
    if (entry.count > 0 && (addedBusiest === null || entry.count > addedBusiest.count)) {
      addedBusiest = { month: entry.month, count: entry.count };
    }
  }

  return {
    year,
    window,
    hasFanfics: total.fanfics > 0,
    tiles: {
      total,
      read,
      reading,
      dnf,
      unread,
      period: {
        read: periodSplit,
        reread,
        words,
        hours: words / (Math.max(1, wordsPerMinute) * 60),
        averageRating: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
        rated: ratings.length,
        fiveStars: ratings.filter((value) => value >= 5).length,
      },
    },
    byYear,
    ids: { ...stateIds, periodRead: periodRead.map((book) => book.id), fiveStars: fiveStarIds },
    withFinishDate,
    readTotal: readBooks.length,
    reads: {
      items,
      count: readsCount,
      medianDays: median(durations),
      withStart: durations.length,
      buckets,
      longest,
    },
    highlightsByDay,
    readingDays,
    readingDaysCount: Object.keys(readingDays).length,
    highlightsByMonth,
    highlightsTotal,
    highlightsDays: Object.keys(highlightsByDay).length,
    recordDay,
    busiestMonth,
    topHighlighted: [...perBook.values()].sort(byCountThenName((item) => item.title)).slice(0, 4),
    topAuthors: [...authorBooks.entries()]
      .map(([name, ids]) => ({ name, count: ids.length, ids }))
      .sort(byCountThenName((item) => item.name))
      .slice(0, 6),
    ratingDistribution: RATING_STEPS.map((value, index) => ({
      value,
      count: ratingIds[index].length,
      ids: ratingIds[index],
    })),
    genres: [...genreBooks.entries()]
      .map(([genre, ids]) => ({ genre, count: ids.length, ids }))
      .sort(byCountThenName((item) => item.genre))
      .slice(0, 12),
    reading: { total: reading.total, items: inProgress.slice(0, 6) },
    added: { total: addedTotal, byMonth: addedByMonth, busiest: addedBusiest },
  };
}
