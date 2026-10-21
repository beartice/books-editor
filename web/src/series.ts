import type { BookSummary, SeriesVolume } from '@shared/types';

export interface SeriesGroup {
  key: string;
  name: string;
  authors: string[];
  books: BookSummary[];
  indexes: number[];
  missingIndexes: number[];
  isbns: string[];
  /** Link AO3 delle opere possedute: servono a trovare le altre parti della serie. */
  ao3Urls: string[];
  hasBookKind: boolean;
  hasFanfic: boolean;
}

export interface SeriesRow {
  key: string;
  index: number | null;
  title: string;
  subtitle: string;
  authors: string[];
  releaseDate: string;
  owned: boolean;
  localBook?: BookSummary;
  online?: SeriesVolume;
}

/** Chiave stabile per raggruppare varianti tipografiche dello stesso nome. */
export function normalizeSeriesName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSeriesGroups(books: BookSummary[]): SeriesGroup[] {
  const grouped = new Map<string, { name: string; books: BookSummary[] }>();

  for (const book of books) {
    const name = book.series.trim();
    if (!name) continue;
    const key = normalizeSeriesName(name);
    if (!key) continue;
    const existing = grouped.get(key);
    if (existing) existing.books.push(book);
    else grouped.set(key, { name, books: [book] });
  }

  return [...grouped.entries()]
    .map(([key, group]) => {
      const sorted = [...group.books].sort((a, b) => {
        const ai = a.seriesIndex ?? Number.POSITIVE_INFINITY;
        const bi = b.seriesIndex ?? Number.POSITIVE_INFINITY;
        if (ai !== bi) return ai - bi;
        return (a.publishedDate || a.title).localeCompare(b.publishedDate || b.title, 'it');
      });
      const authors = [...new Set(sorted.flatMap((book) => book.authors).filter(Boolean))];
      const isbns = [
        ...new Set(
          sorted
            .map((book) => book.isbn.replace(/[^0-9Xx]/g, '').toUpperCase())
            .filter((isbn) => /^\d{13}$/.test(isbn) || /^\d{9}[\dX]$/.test(isbn)),
        ),
      ];
      const ao3Urls = [
        ...new Set(sorted.map((book) => (book.ao3Url ?? '').trim()).filter(Boolean)),
      ];
      const indexes = [
        ...new Set(
          sorted
            .map((book) => book.seriesIndex)
            .filter((index): index is number => index !== null && Number.isFinite(index)),
        ),
      ].sort((a, b) => a - b);
      const maxIndex = indexes.length ? Math.floor(Math.max(...indexes)) : 0;
      const missingIndexes: number[] = [];
      for (let index = 1; index <= maxIndex; index += 1) {
        if (!indexes.some((value) => Math.abs(value - index) < 0.001)) {
          missingIndexes.push(index);
        }
      }

      return {
        key,
        name: group.name,
        authors,
        books: sorted,
        indexes,
        missingIndexes,
        isbns,
        ao3Urls,
        hasBookKind: sorted.some((book) => book.kind === 'book'),
        hasFanfic: sorted.some((book) => book.kind === 'fanfic'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));
}

function sameTitle(a: string, b: string): boolean {
  return normalizeSeriesName(a) === normalizeSeriesName(b);
}

export function buildSeriesRows(
  group: SeriesGroup,
  online: SeriesVolume[],
  totalVolumes = 0,
): SeriesRow[] {
  const rows: SeriesRow[] = [];

  for (const book of group.books) {
    rows.push({
      key: `local:${book.id}`,
      index: book.seriesIndex,
      title: book.title,
      subtitle: book.subtitle,
      authors: book.authors,
      releaseDate: book.publishedDate,
      owned: true,
      localBook: book,
    });
  }

  for (const volume of online) {
    const indexedRow =
      volume.index !== null
        ? rows.find((row) => row.index !== null && Math.abs(row.index - volume.index!) < 0.001)
        : undefined;
    const titleRow = rows.find((row) => row.owned && sameTitle(row.title, volume.title));
    const match = indexedRow ?? titleRow;

    if (match?.owned) {
      if (!match.releaseDate && volume.releaseDate) match.releaseDate = volume.releaseDate;
      if (!match.online) match.online = volume;
      continue;
    }

    if (match) continue;

    rows.push({
      key:
        volume.index !== null
          ? `online:${volume.index}:${normalizeSeriesName(volume.title)}`
          : `online:x:${normalizeSeriesName(volume.title)}`,
      index: volume.index,
      title: volume.title,
      subtitle: volume.subtitle,
      authors: volume.authors.length ? volume.authors : group.authors,
      releaseDate: volume.releaseDate,
      owned: false,
      online: volume,
    });
  }

  const knownIndexes = rows
    .map((row) => row.index)
    .filter((index): index is number => index !== null && Number.isFinite(index));
  const inferredMax = knownIndexes.length ? Math.floor(Math.max(...knownIndexes)) : 0;
  const maxKnown = Math.max(inferredMax, Math.max(0, Math.floor(totalVolumes)));

  for (let index = 1; index <= maxKnown; index += 1) {
    if (rows.some((row) => row.index !== null && Math.abs(row.index - index) < 0.001)) continue;
    rows.push({
      key: `gap:${index}`,
      index,
      title: '',
      subtitle: '',
      authors: group.authors,
      releaseDate: '',
      owned: false,
    });
  }

  return rows.sort((a, b) => {
    if (a.index !== null && b.index !== null) {
      if (a.index !== b.index) return a.index - b.index;
      return Number(b.owned) - Number(a.owned);
    }
    if (a.index !== null) return -1;
    if (b.index !== null) return 1;
    return a.title.localeCompare(b.title, 'it');
  });
}

function italianDate(date: Date, includeDay: boolean): string {
  return new Intl.DateTimeFormat('it-IT', {
    ...(includeDay ? { day: 'numeric' as const } : {}),
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Formatta AAAA-MM-GG, AAAA-MM o AAAA senza introdurre slittamenti di fuso. */
export function formatReleaseDate(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';

  const full = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (full) {
    const date = new Date(
      Date.UTC(Number(full[1]), Number(full[2]) - 1, Number(full[3]), 12),
    );
    if (!Number.isNaN(date.getTime())) return italianDate(date, true);
  }

  const yearMonth = raw.match(/^(\d{4})-(\d{2})$/);
  if (yearMonth) {
    const date = new Date(Date.UTC(Number(yearMonth[1]), Number(yearMonth[2]) - 1, 1, 12));
    if (!Number.isNaN(date.getTime())) return italianDate(date, false);
  }

  const year = raw.match(/^\d{4}$/);
  if (year) return year[0];

  return raw;
}
