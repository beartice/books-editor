import type { MetadataCandidate } from '../../../shared/types.js';
import { htmlToText } from '../htmlText.js';

const ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';

interface GoogleVolume {
  id: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
    pageCount?: number;
    categories?: string[];
    language?: string;
    imageLinks?: Record<string, string>;
  };
}

function resolveApiKey(settingsApiKey: string): string {
  // La chiave salvata nelle impostazioni ha la precedenza su quella d'ambiente,
  // così si può configurare dall'interfaccia senza riavviare il server.
  return settingsApiKey.trim() || process.env.GOOGLE_BOOKS_API_KEY?.trim() || '';
}

function upgradeCover(url: string | undefined): string | null {
  if (!url) return null;
  let out = url.replace(/^http:/, 'https:');
  out = out.replace(/&zoom=\d+/, '').replace(/zoom=\d+/, '');
  out += out.includes('?') ? '&zoom=2' : '?zoom=2';
  return out;
}

interface GoogleError {
  error?: {
    message?: string;
    details?: Array<{ metadata?: Record<string, string> }>;
  };
}

/** Prossima mezzanotte del Pacifico: e' quando Google azzera la quota giornaliera. */
function nextQuotaReset(now = new Date()): Date {
  const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const offset = now.getTime() - pacific.getTime();
  const midnight = new Date(pacific);
  midnight.setHours(24, 0, 0, 0);
  return new Date(midnight.getTime() + offset);
}

/**
 * Quota giornaliera esaurita: fino all'azzeramento ogni richiesta fallirebbe
 * comunque, quindi non chiamiamo piu' Google e rispondiamo subito.
 */
let quotaBlockedUntil = 0;

function quotaMessage(): string {
  const time = new Date(quotaBlockedUntil).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `quota giornaliera della chiave API esaurita (HTTP 429). Si azzera alle ${time}; nel frattempo usa Open Library`;
}

function errorForStatus(status: number, body: GoogleError = {}, hasKey = false): string {
  if (status === 429) {
    const meta = body.error?.details?.find((detail) => detail.metadata)?.metadata ?? {};
    const daily = /day/i.test(meta.quota_limit ?? '') || /per day/i.test(body.error?.message ?? '');
    if (daily && hasKey) {
      quotaBlockedUntil = nextQuotaReset().getTime();
      return quotaMessage();
    }
    if (!hasKey) {
      return 'senza chiave API Google Books non concede richieste (HTTP 429). Aggiungi una chiave gratuita nelle impostazioni';
    }
    return 'troppe richieste in poco tempo (HTTP 429). Riprova tra un minuto';
  }
  if (status === 400 || status === 403) {
    return `chiave API non valida o quota esaurita (HTTP ${status}). Controlla la chiave nelle impostazioni o riprova più tardi`;
  }
  if (status === 404) {
    return 'edizione non trovata (HTTP 404). Controlla il link o l\'ID Google Books';
  }
  if (status >= 500) {
    return `servizio temporaneamente non disponibile (HTTP ${status}). Riprova tra poco oppure incolla il link diretto dell'edizione Google Books`;
  }
  return `HTTP ${status}`;
}

/**
 * L'endpoint di ricerca di Google Books restituisce spesso 503 "backendFailed"
 * in modo intermittente, mentre il GET di una singola edizione è stabile.
 * Misurato a ottobre 2026: con chiave valida riesce circa 1 richiesta su 4.
 * Anche i tentativi falliti consumano la quota giornaliera (1000 richieste),
 * quindi ci fermiamo a 6: circa una ricerca su sei fallisce, ma una ricerca
 * costa al massimo 6 richieste.
 */
const GOOGLE_ATTEMPTS = 6;

async function requestGoogle<T>(url: URL): Promise<T> {
  const hasKey = url.searchParams.has('key');
  if (hasKey && Date.now() < quotaBlockedUntil) throw new Error(quotaMessage());
  for (let attempt = 0; attempt < GOOGLE_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'books-editor/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status >= 500 && attempt < GOOGLE_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      continue;
    }
    const body = (await response.json().catch(() => ({}))) as GoogleError;
    throw new Error(errorForStatus(response.status, body, hasKey));
  }
  throw new Error(errorForStatus(503));
}

function mapVolume(item: GoogleVolume): MetadataCandidate {
  const info = item.volumeInfo ?? {};
  const identifiers: Record<string, string> = { googlebooks: item.id };
  const isbn = (info.industryIdentifiers ?? []).find((i) => /ISBN/i.test(i.type ?? ''))?.identifier;
  if (isbn) identifiers.isbn = isbn.replace(/-/g, '');
  const description = htmlToText(info.description);

  return {
    provider: 'googlebooks',
    label: 'Google Books',
    url: `https://books.google.com/books?id=${item.id}`,
    coverUrl: upgradeCover(info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail),
    summary: description.slice(0, 400) || null,
    fields: {
      title: info.title ?? '',
      subtitle: info.subtitle ?? '',
      authors: info.authors ?? [],
      publisher: info.publisher ?? '',
      publishedDate: info.publishedDate ?? '',
      description,
      language: info.language ?? '',
      isbn: isbn ?? '',
      identifiers,
      pageCount: info.pageCount ?? null,
      tags: info.categories ?? [],
      kind: 'book',
    },
  } satisfies MetadataCandidate;
}

/** Risultati gia' ottenuti: ripetere la stessa ricerca non consuma quota. */
const SEARCH_CACHE_TTL = 6 * 60 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map<string, { at: number; items: GoogleVolume[] }>();

async function searchOnce(query: string, limit: number, apiKey: string): Promise<GoogleVolume[]> {
  const cacheKey = `${limit}:${query.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL) return cached.items;

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('maxResults', String(limit));
  url.searchParams.set('printType', 'books');
  if (apiKey) url.searchParams.set('key', apiKey);

  const data = await requestGoogle<{ items?: GoogleVolume[] }>(url);
  const items = data.items ?? [];
  searchCache.set(cacheKey, { at: Date.now(), items });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value as string);
  }
  return items;
}

/**
 * Una sola richiesta, senza `langRestrict`: filtrare per lingua e poi ripetere
 * senza filtro raddoppiava il consumo di quota. La lingua del libro conta
 * nell'ordinamento dei risultati (lookupOnline).
 */
export async function searchGoogleBooks(
  query: string,
  limit = 20,
  settingsApiKey = '',
  /** Tiene solo i risultati pertinenti (la ricerca a testo libero e' larga). */
  accept: (candidate: MetadataCandidate) => boolean = () => true,
): Promise<MetadataCandidate[]> {
  const apiKey = resolveApiKey(settingsApiKey);
  return (await searchOnce(query, limit, apiKey)).map(mapVolume).filter(accept);
}

/** Carica una singola edizione tramite il suo ID (o URL) Google Books. */
export async function fetchGoogleBookVolume(
  volumeId: string,
  settingsApiKey = '',
): Promise<MetadataCandidate> {
  const apiKey = resolveApiKey(settingsApiKey);
  const url = new URL(`${ENDPOINT}/${encodeURIComponent(volumeId)}`);
  if (apiKey) url.searchParams.set('key', apiKey);
  const data = await requestGoogle<GoogleVolume>(url);
  return mapVolume(data);
}

/**
 * Estrae l'ID del volume da un link Google Books o da un ID incollato.
 * Accetta:
 *   https://www.google.it/books/edition/Titolo/1LwFtAEACAAJ?hl=en
 *   https://books.google.com/books?id=1LwFtAEACAAJ
 *   https://www.googleapis.com/books/v1/volumes/1LwFtAEACAAJ
 *   1LwFtAEACAAJ
 */
export function parseGoogleBooksVolumeId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const idPattern = /^[A-Za-z0-9_-]{5,}$/;
  if (idPattern.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const isGoogleHost = host === 'www.googleapis.com' || /(^|\.)google\.[a-z.]+$/.test(host);
  if (!isGoogleHost) return null;

  const fromQuery = url.searchParams.get('id');
  if (fromQuery && idPattern.test(fromQuery)) return fromQuery;

  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (idPattern.test(last)) return last;

  return null;
}
