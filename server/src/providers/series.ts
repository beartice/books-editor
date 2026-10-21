import type { BookKind, SeriesLookupResult, SeriesVolume } from '../../../shared/types.js';
import { searchGoogleBooks } from './googlebooks.js';
import { lookupGoodreadsSeries } from './goodreads.js';
import { lookupAo3Series } from './ao3series.js';
import { readSeriesCache, writeSeriesCache } from '../seriesCache.js';

const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json';
// Le serie cambiano raramente: una cache lunga evita di interrogare più volte
// Goodreads, che limita le richieste automatiche. Il refresh manuale la ignora.
const DAY = 24 * 60 * 60 * 1000;
/** Durata usata se le impostazioni non arrivano (30 giorni, come il default). */
const DEFAULT_REFRESH_DAYS = 30;

interface OpenLibrarySeriesDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  publish_date?: string[];
  series_name?: string[];
  series_position?: string[];
  cover_i?: number;
  isbn?: string[];
}

const cache = new Map<string, { at: number; value: SeriesLookupResult }>();

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seriesForms(series: string): string[] {
  const cleaned = series
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const forms = new Set<string>();

  for (const value of [series.trim(), cleaned]) {
    if (!value) continue;
    forms.add(value);
    const withoutSuffix = value
      .replace(/\s+(?:series|saga|trilogy|collection|cycle)$/i, '')
      .trim();
    if (withoutSuffix) forms.add(withoutSuffix);
  }

  return [...forms];
}

function matchesSeries(values: string[], series: string): boolean {
  const targets = seriesForms(series)
    .map(normalize)
    .filter((value) => value.length > 2);
  return values.some((value) => {
    const candidate = normalize(value);
    if (candidate.length < 3) return false;
    return targets.some(
      (target) => candidate === target || candidate.includes(target) || target.includes(candidate),
    );
  });
}

function textMatchesSeries(text: string, series: string): boolean {
  const candidate = normalize(text);
  if (!candidate) return false;
  return seriesForms(series)
    .map(normalize)
    .filter((value) => value.length > 2)
    .some((target) => candidate.includes(target));
}

function matchesAuthors(candidateAuthors: string[], authors: string[]): boolean {
  const targets = authors.map(normalize).filter((value) => value.length > 2);
  if (targets.length === 0) return true;
  const candidates = candidateAuthors.map(normalize).filter(Boolean);
  if (candidates.length === 0) return false;
  return candidates.some((candidate) =>
    targets.some(
      (target) => candidate === target || candidate.includes(target) || target.includes(candidate),
    ),
  );
}

function isCompilation(title: string, subtitle = ''): boolean {
  const value = normalize(`${title} ${subtitle}`);
  if (
    /\b(?:box(?:ed)? set|books set|series set|complete series|omnibus|bundle|slipcase)\b/.test(
      value,
    )
  ) {
    return true;
  }
  if (/\bcollection\b/.test(value) && /\bseries\b/.test(value)) return true;
  return /\b(?:coloring|colouring|journal|notebook|planner|calendar|companion guide)\b/.test(
    value,
  );
}

function toIndex(value: string): number | null {
  const number = Number.parseFloat(value.replace(',', '.'));
  if (!Number.isFinite(number) || number <= 0 || number >= 1000) return null;
  return number;
}

function parseIndexValue(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseIndexValue(item);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? toIndex(String(value)) : null;
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;
  if (/^\d+(?:[.,]\d+)?$/.test(raw)) return toIndex(raw);
  if (/^\d+\s*-\s*\d+$/.test(raw)) return null;

  const labelled = raw.match(
    /\b(?:book|volume|vol\.?|part|tome|livre|livro|band|tom)\s*(?:#|n\.?)?\s*(\d+(?:[.,]\d+)?)\b/i,
  );
  if (labelled) return toIndex(labelled[1]);

  const hash = raw.match(/#\s*(\d+(?:[.,]\d+)?)/);
  if (hash) return toIndex(hash[1]);

  return null;
}

function parseIndexFromTitle(title: string, subtitle = ''): number | null {
  const text = `${title} ${subtitle}`;
  for (const match of text.matchAll(/\(([^)]*)\)/g)) {
    const inside = parseIndexValue(match[1]);
    if (inside !== null) return inside;
  }
  return parseIndexValue(text);
}

function cleanTitle(title: string): string {
  const cleaned = title
    .replace(/\s*\([^)]*(?:#\s*\d+|book\s*\d+|series)[^)]*\)\s*$/i, '')
    .trim();
  return cleaned || title;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

interface ParsedDate {
  iso: string;
  year: number;
  precision: number;
  timestamp: number;
}

function parseDatePart(value: unknown): ParsedDate | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const yearOnly = raw.match(/^(\d{4})$/);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return { iso: yearOnly[1], year, precision: 1, timestamp: Date.UTC(year, 0, 1) };
  }

  const yearMonth = raw.match(/^(\d{4})-(\d{1,2})$/);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    if (month >= 1 && month <= 12) {
      return {
        iso: `${yearMonth[1]}-${pad(month)}`,
        year,
        precision: 2,
        timestamp: Date.UTC(year, month - 1, 1),
      };
    }
  }

  const fullIso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (fullIso) {
    const year = Number(fullIso[1]);
    const month = Number(fullIso[2]);
    const day = Number(fullIso[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        iso: `${fullIso[1]}-${pad(month)}-${pad(day)}`,
        year,
        precision: 3,
        timestamp: Date.UTC(year, month - 1, day),
      };
    }
  }

  const looksLikeMonthDay = /[a-z]{3,}/i.test(raw);
  const looksLikeNumericDate = /^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(raw);
  if (looksLikeMonthDay || looksLikeNumericDate) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = parsed.getMonth() + 1;
      const day = parsed.getDate();
      const hasDay =
        looksLikeNumericDate ||
        /\b\d{1,2}(?:st|nd|rd|th)?\b/.test(raw.replace(/\b\d{4}\b/g, ''));
      return {
        iso: hasDay ? `${year}-${pad(month)}-${pad(day)}` : `${year}-${pad(month)}`,
        year,
        precision: hasDay ? 3 : 2,
        timestamp: Date.UTC(year, month - 1, hasDay ? day : 1),
      };
    }
  }

  const yearFromText = raw.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  if (yearFromText) {
    const year = Number(yearFromText[1]);
    return { iso: yearFromText[1], year, precision: 1, timestamp: Date.UTC(year, 0, 1) };
  }

  return null;
}

function pickBestDate(candidates: ParsedDate[]): ParsedDate | null {
  let best: ParsedDate | null = null;
  for (const candidate of candidates) {
    if (
      !best ||
      candidate.precision > best.precision ||
      (candidate.precision === best.precision && candidate.timestamp < best.timestamp)
    ) {
      best = candidate;
    }
  }
  return best;
}

function normalizeReleaseDate(firstYear: unknown, publishDates: unknown): string {
  const year =
    typeof firstYear === 'number' && Number.isInteger(firstYear) && firstYear > 0
      ? firstYear
      : typeof firstYear === 'string' && /^\d{4}$/.test(firstYear.trim())
        ? Number(firstYear)
        : null;

  const rawDates = Array.isArray(publishDates)
    ? publishDates
    : publishDates
      ? [publishDates]
      : [];
  const parsed = rawDates
    .map(parseDatePart)
    .filter((date): date is ParsedDate => date !== null);

  if (year) {
    const sameYear = parsed.filter((date) => date.year === year);
    const best = pickBestDate(sameYear);
    return best?.iso ?? String(year);
  }

  if (parsed.length > 0) {
    const earliestYear = Math.min(...parsed.map((date) => date.year));
    const best = pickBestDate(parsed.filter((date) => date.year === earliestYear));
    if (best) return best.iso;
  }

  return '';
}

function coverFromOpenLibrary(coverId: unknown): string | null {
  return typeof coverId === 'number'
    ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
    : null;
}

function mapOpenLibraryDoc(
  doc: OpenLibrarySeriesDoc,
  series: string,
  authors: string[],
): SeriesVolume | null {
  const title = (doc.title ?? '').trim();
  if (!title) return null;
  const subtitle = (doc.subtitle ?? '').trim();
  if (isCompilation(title, subtitle)) return null;

  const seriesNames = Array.isArray(doc.series_name) ? doc.series_name : [];
  const matchedSeries = matchesSeries(seriesNames, series);
  const matchedTitle = textMatchesSeries(`${title} ${subtitle}`, series);

  if (!matchedSeries) {
    // La ricerca per serie di Open Library può restituire titoli che citano
    // parole simili. Accettiamo un titolo senza series_name solo se ha un
    // numero di volume e l'autore coincide con quello della libreria.
    if (seriesNames.length > 0 || !matchedTitle) return null;
    if (!matchesAuthors(doc.author_name ?? [], authors)) return null;
  }

  const index =
    parseIndexValue(doc.series_position) ?? parseIndexFromTitle(title, subtitle);
  if (!matchedSeries && index === null) return null;

  const isbn = doc.isbn?.find((value) => value.length === 13) ?? doc.isbn?.[0] ?? '';

  return {
    index,
    title: cleanTitle(title),
    subtitle,
    authors: doc.author_name ?? [],
    releaseDate: normalizeReleaseDate(doc.first_publish_year, doc.publish_date),
    provider: 'openlibrary',
    providerLabel: 'Open Library',
    url: doc.key ? `https://openlibrary.org${doc.key}` : null,
    coverUrl: coverFromOpenLibrary(doc.cover_i),
    isbn,
  };
}

async function searchOpenLibrarySeries(
  series: string,
  authors: string[],
): Promise<SeriesVolume[]> {
  const fields = [
    'key',
    'title',
    'subtitle',
    'author_name',
    'first_publish_year',
    'publish_date',
    'series_name',
    'series_position',
    'cover_i',
    'isbn',
  ].join(',');

  for (const form of seriesForms(series)) {
    const url = new URL(OPENLIBRARY_SEARCH);
    url.searchParams.set('q', `series:"${form.replace(/"/g, '')}"`);
    url.searchParams.set('limit', '60');
    url.searchParams.set('fields', fields);

    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'books-editor/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as { docs?: OpenLibrarySeriesDoc[] };
    const volumes = (data.docs ?? [])
      .map((doc) => mapOpenLibraryDoc(doc, form, authors))
      .filter((volume): volume is SeriesVolume => volume !== null);

    if (volumes.length > 0) return volumes;
  }

  return [];
}

function normalizeGoogleCandidate(
  candidate: Awaited<ReturnType<typeof searchGoogleBooks>>[number],
  series: string,
  authors: string[],
): SeriesVolume | null {
  const title = String(candidate.fields.title ?? '').trim();
  const subtitle = String(candidate.fields.subtitle ?? '').trim();
  if (!title || isCompilation(title, subtitle)) return null;
  if (!textMatchesSeries(`${title} ${subtitle}`, series)) return null;
  const candidateAuthors = candidate.fields.authors ?? [];
  if (candidateAuthors.length > 0 && !matchesAuthors(candidateAuthors, authors)) return null;

  return {
    index: parseIndexFromTitle(title, subtitle),
    title: cleanTitle(title),
    subtitle,
    authors: candidate.fields.authors ?? [],
    releaseDate: normalizeReleaseDate(undefined, candidate.fields.publishedDate),
    provider: 'googlebooks',
    providerLabel: 'Google Books',
    url: candidate.url ?? null,
    coverUrl: candidate.coverUrl ?? null,
    isbn: String(candidate.fields.isbn ?? ''),
  };
}

async function searchGoogleSeries(
  series: string,
  authors: string[],
  apiKey: string,
): Promise<SeriesVolume[]> {
  const forms = seriesForms(series);
  const author = authors.find((value) => value.trim())?.trim() ?? '';
  const queries: string[] = [];

  // Testo libero: gli operatori intitle:/inauthor: oggi restituiscono zero
  // risultati e ogni tentativo consuma quota. I volumi estranei vengono
  // scartati da normalizeGoogleCandidate (serie e autore devono combaciare).
  const form = (forms[0] ?? series).replace(/"/g, '');
  if (author) queries.push(`${form} ${author.replace(/"/g, '')}`);
  queries.push(form);

  const seen = new Set<string>();
  let lastError: Error | null = null;
  let gotResponse = false;

  for (const query of queries) {
    try {
      const candidates = await searchGoogleBooks(query, 20, apiKey);
      gotResponse = true;
      const volumes = candidates
        .map((candidate) => normalizeGoogleCandidate(candidate, series, authors))
        .filter((volume): volume is SeriesVolume => volume !== null);
      const unique = volumes.filter((volume) => {
        const key = `${volume.index ?? 'x'}:${normalize(volume.title)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length > 0) return unique;
    } catch (error) {
      // Una query può fallire con 503 mentre un'altra forma della stessa
      // ricerca risponde: proviamo tutte le varianti prima di arrenderci.
      lastError = error as Error;
    }
  }

  if (lastError && !gotResponse) throw lastError;
  return [];
}

function volumeScore(volume: SeriesVolume): number {
  return (
    (volume.index !== null ? 8 : 0) +
    (volume.releaseDate ? 4 : 0) +
    (volume.coverUrl ? 2 : 0) +
    (volume.url ? 1 : 0) +
    (volume.isbn ? 1 : 0)
  );
}

function mergeVolume(existing: SeriesVolume, incoming: SeriesVolume): SeriesVolume {
  const winner =
    volumeScore(incoming) > volumeScore(existing) ? incoming : existing;
  const loser = winner === incoming ? existing : incoming;
  return {
    ...winner,
    authors: winner.authors.length ? winner.authors : loser.authors,
    releaseDate: winner.releaseDate || loser.releaseDate,
    coverUrl: winner.coverUrl || loser.coverUrl,
    url: winner.url || loser.url,
    isbn: winner.isbn || loser.isbn,
  };
}

function dedupeVolumes(volumes: SeriesVolume[]): SeriesVolume[] {
  const indexed = new Map<number, SeriesVolume>();
  const unindexed = new Map<string, SeriesVolume>();

  for (const volume of volumes) {
    if (volume.index !== null) {
      const existing = indexed.get(volume.index);
      indexed.set(volume.index, existing ? mergeVolume(existing, volume) : volume);
      continue;
    }

    const key = normalize(volume.title);
    const existing = unindexed.get(key);
    unindexed.set(key, existing ? mergeVolume(existing, volume) : volume);
  }

  return [...indexed.values(), ...unindexed.values()].sort((a, b) => {
    if (a.index !== null && b.index !== null) return a.index - b.index;
    if (a.index !== null) return -1;
    if (b.index !== null) return 1;
    return a.title.localeCompare(b.title, 'it');
  });
}

/**
 * Chiave stabile della cache: non dipende da ISBN, fonti o link AO3, che
 * cambiano aggiungendo un volume o modificando le impostazioni.
 */
export function seriesCacheKey(
  series: string,
  authors: string[],
  kind: 'book' | 'fanfic',
): string {
  return `${normalize(series)}|${authors.map(normalize).sort().join(',')}|${kind}`;
}

function ttlFromDays(refreshDays?: number): number {
  const days =
    Number.isFinite(refreshDays) && (refreshDays ?? 0) > 0
      ? (refreshDays as number)
      : DEFAULT_REFRESH_DAYS;
  return days * DAY;
}

/**
 * Legge dalla cache (memoria, poi file) senza fare richieste di rete.
 * Stessa chiave e stessa scadenza di lookupSeries.
 */
export async function readCachedSeries(
  series: string,
  authors: string[],
  kind: 'book' | 'fanfic',
  refreshDays?: number,
): Promise<{ volumes: SeriesVolume[]; at: number } | null> {
  if (!series.trim()) return null;
  const cacheKey = seriesCacheKey(series.trim(), authors, kind);
  const cacheTtl = ttlFromDays(refreshDays);
  const memory = cache.get(cacheKey);
  if (memory && Date.now() - memory.at < cacheTtl) {
    return { volumes: memory.value.volumes, at: memory.at };
  }
  const stored = await readSeriesCache(cacheKey, cacheTtl);
  if (stored === null) return null;
  cache.set(cacheKey, { at: stored.at, value: { volumes: stored.volumes, errors: [] } });
  return { volumes: stored.volumes, at: stored.at };
}

/**
 * Cerca online i volumi che compongono una serie. Non modifica la libreria:
 * restituisce solo i dati che l'interfaccia usa per mostrare i volumi mancanti.
 */
export async function lookupSeries(
  series: string,
  authors: string[],
  providers: string[],
  options: {
    googleBooksApiKey?: string;
    refresh?: boolean;
    /** Giorni di validità della cache (Impostazioni). */
    refreshDays?: number;
    isbns?: string[];
    ao3Urls?: string[];
    kind?: BookKind;
  } = {},
): Promise<SeriesLookupResult> {
  const cleanSeries = series.trim();
  if (!cleanSeries) return { volumes: [], errors: [] };

  const cacheTtl = ttlFromDays(options.refreshDays);

  const fanficOnly = options.kind === 'fanfic';
  const ao3Urls = [
    ...new Set(
      (options.ao3Urls ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, 8);

  const isbns = [
    ...new Set(
      (options.isbns ?? [])
        .map((value) => value.replace(/[^0-9Xx]/g, '').toUpperCase())
        .filter((value) => /^\d{13}$/.test(value) || /^\d{9}[\dX]$/.test(value)),
    ),
  ].slice(0, 5);

  const cacheKey = seriesCacheKey(cleanSeries, authors, fanficOnly ? 'fanfic' : 'book');
  const cached = cache.get(cacheKey);
  if (!options.refresh && cached && Date.now() - cached.at < cacheTtl) {
    return cached.value;
  }

  if (!options.refresh) {
    // Cache persistente in data/series-cache.json: sopravvive ai riavvii e
    // alle nuove sessioni del browser; scade dopo i giorni configurati.
    const stored = await readSeriesCache(cacheKey, cacheTtl);
    if (stored !== null) {
      const value: SeriesLookupResult = { volumes: stored.volumes, errors: [] };
      cache.set(cacheKey, { at: stored.at, value });
      return value;
    }
  }

  const volumes: SeriesVolume[] = [];
  const errors: string[] = [];
  const tasks: Array<Promise<void>> = [];

  if (!fanficOnly && providers.includes('openlibrary')) {
    tasks.push(
      searchOpenLibrarySeries(cleanSeries, authors)
        .then((result) => {
          volumes.push(...result);
        })
        .catch((error) => {
          errors.push(`Open Library: ${(error as Error).message}`);
        }),
    );
  }

  if (!fanficOnly && providers.includes('googlebooks')) {
    tasks.push(
      searchGoogleSeries(cleanSeries, authors, options.googleBooksApiKey ?? '')
        .then((result) => {
          volumes.push(...result);
        })
        .catch((error) => {
          const message = (error as Error).message.replace(
            /\s*Riprova tra poco oppure incolla il link diretto dell'edizione Google Books\.?$/i,
            '',
          );
          errors.push(`Google Books: ${message}`);
        }),
    );
  }

  if (ao3Urls.length > 0) {
    tasks.push(
      lookupAo3Series(ao3Urls, { refresh: options.refresh })
        .then((result) => {
          volumes.push(...result);
        })
        .catch((error) => {
          errors.push(`AO3: ${(error as Error).message}`);
        }),
    );
  }

  await Promise.allSettled(tasks);

  // Open Library e Google Books non conoscono tutte le serie. Goodreads viene
  // interrogato solo come fallback e solo se abbiamo un ISBN: in questo modo
  // non rallentiamo le serie già coperte dalle altre fonti.
  const preliminary = dedupeVolumes(volumes);
  if (
    !fanficOnly &&
    providers.includes('goodreads') &&
    isbns.length > 0 &&
    preliminary.length < 2
  ) {
    try {
      const goodreadsVolumes = await lookupGoodreadsSeries(cleanSeries, authors, isbns);
      if (goodreadsVolumes.length > 0) {
        volumes.push(...goodreadsVolumes);
        // Goodreads ha colmato le lacune: l'eventuale 503 di Google Books non
        // rende incompleta la risposta che mostriamo.
        errors.length = 0;
      }
    } catch (error) {
      const message = (error as Error).message;
      if (preliminary.length === 0) {
        errors.push(`Goodreads: ${message}`);
      } else {
        console.warn(`[series] Goodreads non disponibile per «${cleanSeries}»: ${message}`);
      }
    }
  }

  const value: SeriesLookupResult = {
    volumes: dedupeVolumes(volumes),
    errors,
  };

  if (errors.length === 0) {
    cache.set(cacheKey, { at: Date.now(), value });
    try {
      await writeSeriesCache(cacheKey, value.volumes);
    } catch (error) {
      // La cache è un'ottimizzazione: se il disco non è scrivibile la ricerca
      // resta comunque valida.
      console.warn(`[series] impossibile salvare la cache: ${(error as Error).message}`);
    }
  }

  return value;
}
