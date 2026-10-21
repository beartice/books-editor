import type { MetadataCandidate } from '../../../shared/types.js';

const SEARCH = 'https://openlibrary.org/search.json';
const BASE = 'https://openlibrary.org';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'books-editor/1.0' };

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  publish_date?: string[];
  publisher?: string[];
  isbn?: string[];
  number_of_pages_median?: number;
  language?: string[];
  subject?: string[];
  cover_i?: number;
  cover_edition_key?: string;
  first_sentence?: string[];
}

/** `description` di opere ed edizioni: stringa oppure `{ type, value }`. */
type OpenLibraryText = string | { value?: string } | undefined;

/**
 * Pulisce la descrizione: a capo uniformi e via i riferimenti in stile
 * markdown che Open Library si porta dietro ("([source][1])", "[1]: https://...",
 * righe "----------" seguite da link "See also").
 */
function cleanDescription(text: OpenLibraryText): string {
  const raw = typeof text === 'string' ? text : (text?.value ?? '');
  let clean = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\n-{3,}[\s\S]*$/, '')
    .replace(/^\s*\[\d+\]:\s*\S+.*$/gm, '')
    .replace(/\(\[(?:source|fonte)\]\[\d+\]\)/gi, '')
    .replace(/\[([^\]]+)\]\[\d+\]/g, '$1')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]+\)/g, '$1')
    // Enfasi markdown: **testo**, __testo__, *testo*, _testo_; titoli "# ...".
    .replace(/(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[\s(“"'])[*_](?=\S)([^*_\n]+?)(?<=\S)[*_](?=[\s.,;:!?)”"']|$)/gm, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Schede di catalogo (Library of Congress): "Testo..."--Provided by publisher.
  const catalog = clean.match(/^"([\s\S]+)"\s*--\s*(?:provided by publisher\.?|publisher\.?)?$/i);
  if (catalog) clean = (catalog[1] ?? '').trim();

  // Note promozionali in coda ("Knopf is planning a major publicity blitz...").
  // Lo split tiene i separatori (spazi e a capo) per non perdere i paragrafi:
  // [frase, separatore, frase, separatore, ...].
  const parts = clean.split(/((?<=[.!?…])[ \t]+(?=[A-Z"“])|\n+)/);
  while (
    parts.length > 1 &&
    /\b(publicity|marketing|advertising|on sale|on the heels of|lead title|first printing|multi-city|pre-?order)\b/i.test(
      parts[parts.length - 1]!,
    )
  ) {
    parts.splice(-2, 2);
  }
  return parts.join('').trim();
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

interface OpenLibraryEdition {
  series?: string[];
  description?: OpenLibraryText;
}

interface ParsedSeries {
  name: string;
  index: number | null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, primo: 1, secondo: 2, terzo: 3,
};
const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

function numberFrom(token: string): number | null {
  const value = token.toLowerCase().replace(/\.$/, '');
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  return NUMBER_WORDS[value] ?? ROMAN[value] ?? null;
}

/**
 * Il campo `series` delle edizioni non ha un formato fisso:
 *   "Gilded #1", "The Nevernight Chronicle (#1)", "Nevernight, Band I",
 *   "Nevernight -- Book one", "Folk of the Air ; 3", "Crowns of Nyaxia Series".
 */
export function parseSeries(raw: string): ParsedSeries | null {
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return null;
  const marker =
    /(?:\(\s*)?(?:#|\b(?:book|bk\.?|vol\.?|volume|v\.|band|tome|tomo|libro|part|no\.?|nr\.?|n\.)\s*)\s*(\d+(?:\.\d+)?|[ivx]+\b|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|primo|secondo|terzo)\s*\)?\s*$/i;
  const trailing = /[;,]\s*(\d+(?:\.\d+)?)\s*$|\(\s*(\d+(?:\.\d+)?)\s*\)\s*$/;

  let name = value;
  let index: number | null = null;
  const markerMatch = value.match(marker);
  const trailingMatch = markerMatch ? null : value.match(trailing);
  if (markerMatch) {
    index = numberFrom(markerMatch[1] ?? '');
    name = value.slice(0, markerMatch.index);
  } else if (trailingMatch) {
    index = numberFrom(trailingMatch[1] ?? trailingMatch[2] ?? '');
    name = value.slice(0, trailingMatch.index);
  }
  name = name
    .replace(/\s*(--|[;,:(])\s*$/, '')
    .replace(/\s+series$/i, '')
    .trim();
  return name ? { name, index } : null;
}

/**
 * Serie piu' citata fra le edizioni, e il numero piu' frequente al suo
 * interno: i dati delle singole edizioni hanno errori (un'edizione di
 * Nevernight segnata "#3") e collane editoriali ("Choice -- 142").
 */
function seriesFromEditions(editions: OpenLibraryEdition[]): ParsedSeries | null {
  const groups = new Map<string, { name: string; votes: number; indexes: Map<number, number> }>();
  for (const edition of editions) {
    for (const raw of edition.series ?? []) {
      const parsed = parseSeries(raw);
      if (!parsed) continue;
      const key = parsed.name.toLowerCase().replace(/^the\s+/, '');
      const group = groups.get(key) ?? { name: parsed.name, votes: 0, indexes: new Map() };
      group.votes += 1;
      if (parsed.index !== null) {
        group.indexes.set(parsed.index, (group.indexes.get(parsed.index) ?? 0) + 1);
      }
      groups.set(key, group);
    }
  }
  const best = [...groups.values()].sort((left, right) => right.votes - left.votes)[0];
  if (!best) return null;
  const index = [...best.indexes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  return { name: best.name, index };
}

/**
 * La ricerca non restituisce ne' sinossi ne' serie. La sinossi sta nella
 * scheda dell'opera (/works/OL...W) o in una delle sue edizioni; la serie solo
 * nelle edizioni. Le due richieste partono in parallelo.
 */
async function detailsFor(
  doc: OpenLibraryDoc,
): Promise<{ description: string; series: ParsedSeries | null }> {
  if (!doc.key) return { description: '', series: null };
  const [work, editions] = await Promise.all([
    fetchJson<{ description?: OpenLibraryText }>(`${doc.key}.json`),
    fetchJson<{ entries?: OpenLibraryEdition[] }>(`${doc.key}/editions.json?limit=50`),
  ]);
  const entries = editions?.entries ?? [];
  const description =
    cleanDescription(work?.description) ||
    entries.map((edition) => cleanDescription(edition.description)).find(Boolean) ||
    '';
  return { description, series: seriesFromEditions(entries) };
}

function coverFromDoc(doc: OpenLibraryDoc): string | null {
  if (doc.cover_i) return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
  const isbn = doc.isbn?.find((i) => i.length === 13) ?? doc.isbn?.[0];
  if (isbn) return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
  return null;
}

export async function searchOpenLibrary(query: string, limit = 8): Promise<MetadataCandidate[]> {
  const url = new URL(SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set(
    'fields',
    'key,title,subtitle,author_name,first_publish_year,publish_date,publisher,isbn,number_of_pages_median,language,subject,cover_i,cover_edition_key,first_sentence',
  );

  const response = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { docs?: OpenLibraryDoc[] };
  const docs = data.docs ?? [];
  const details = await Promise.all(docs.map(detailsFor));

  return docs.map((doc, index) => {
    const { description = '', series = null } = details[index] ?? {};
    const isbn = doc.isbn?.find((i) => i.length === 13) ?? doc.isbn?.[0] ?? '';
    const identifiers: Record<string, string> = {};
    if (doc.key) identifiers.openlibrary = doc.key.replace('/works/', '');
    if (isbn) identifiers.isbn = isbn.replace(/-/g, '');

    return {
      provider: 'openlibrary',
      label: 'Open Library',
      url: doc.key ? `https://openlibrary.org${doc.key}` : null,
      coverUrl: coverFromDoc(doc),
      summary: (description || doc.first_sentence?.[0])?.slice(0, 400) ?? null,
      fields: {
        title: doc.title ?? '',
        subtitle: doc.subtitle ?? '',
        authors: doc.author_name ?? [],
        publisher: doc.publisher?.[0] ?? '',
        publishedDate: doc.publish_date?.[0] ?? (doc.first_publish_year ? String(doc.first_publish_year) : ''),
        // La prima frase del libro non e' una sinossi: meglio vuoto che sbagliato.
        description,
        language: doc.language?.[0] ?? '',
        isbn,
        identifiers,
        pageCount: doc.number_of_pages_median ?? null,
        tags: (doc.subject ?? []).slice(0, 12),
        kind: 'book',
        ...(series ? { series: series.name } : {}),
        ...(series?.index != null ? { seriesIndex: series.index } : {}),
      },
    } satisfies MetadataCandidate;
  });
}
