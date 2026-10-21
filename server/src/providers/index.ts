import type { BookMeta, MetadataCandidate } from '../../../shared/types.js';
import {
  fetchGoogleBookVolume,
  parseGoogleBooksVolumeId,
  searchGoogleBooks,
} from './googlebooks.js';
import { searchOpenLibrary } from './openlibrary.js';
import { fetchFanficPage } from './fanfic.js';
import { toIso6391 } from '../language.js';

export interface LookupOutcome {
  candidates: MetadataCandidate[];
  errors: string[];
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Costruisce la query di ricerca a partire dai dati gia' noti. */
export function buildQuery(book: Partial<BookMeta>): {
  google: string;
  googleFallback: string;
  openlibrary: string;
  openlibraryFallback: string;
} {
  const isbn = clean(book.isbn ?? '').replace(/-/g, '');
  const title = clean(book.title ?? '');
  const author = clean(book.authors?.[0] ?? '');

  // Google Books: gli operatori (intitle:, inauthor:, isbn:) oggi restituiscono
  // sempre zero risultati, anche per libri presenti (verificato a ottobre 2026).
  // Il testo libero "titolo autore" funziona; i risultati estranei vengono poi
  // scartati da `relevantTo`.
  const googleByTitle = title ? `${title} ${author}`.trim() : '';
  const openLibraryByTitle = title
    ? author
      ? `title:"${title}" author:"${author}"`
      : `title:"${title}"`
    : '';

  if (isbn) {
    return {
      // Con il titolo si cerca per testo: l'ISBN serve poi a riconoscere
      // l'edizione giusta nell'ordinamento (scoreCandidate).
      google: googleByTitle || `isbn:${isbn}`,
      googleFallback: googleByTitle && author ? title : '',
      openlibrary: `isbn:${isbn}`,
      openlibraryFallback: openLibraryByTitle,
    };
  }
  return {
    google: googleByTitle,
    googleFallback: author ? title : '',
    openlibrary: openLibraryByTitle,
    openlibraryFallback: '',
  };
}

/**
 * Carica una singola edizione da un link/ID Google Books.
 * Utile quando la ricerca non trova l'edizione giusta (o Google Search e' KO).
 */
export async function lookupGoogleVolume(
  input: string,
  options: { googleBooksApiKey?: string } = {},
): Promise<MetadataCandidate> {
  const volumeId = parseGoogleBooksVolumeId(input);
  if (!volumeId) throw new Error('Link o ID Google Books non valido');
  return fetchGoogleBookVolume(volumeId, options.googleBooksApiKey);
}

/** Carica i metadati da un link AO3 (o FanFiction.net) specifico. */
export async function lookupFanficPage(input: string): Promise<MetadataCandidate> {
  const candidate = await fetchFanficPage(input);
  if (!candidate) {
    throw new Error('Nessun metadato riconosciuto nella pagina della fanfic');
  }
  return candidate;
}

/**
 * Cerca i metadati online per un libro/fanfic.
 * Non applica nulla: restituisce candidati che l'utente deve confermare.
 */
export async function lookupOnline(
  book: BookMeta,
  providers: string[],
  language = 'it',
  options: { googleBooksApiKey?: string } = {},
): Promise<LookupOutcome> {
  const errors: string[] = [];
  const candidates: MetadataCandidate[] = [];
  const fanficCandidates: MetadataCandidate[] = [];
  const tasks: Array<Promise<void>> = [];

  // Sorgente fanfic: pagina originale, se il link e' in chiaro. La lanciamo
  // in parallelo alle altre fonti: AO3 puo' essere lento o irraggiungibile.
  const fanficUrl = book.ao3Url || book.ffnetUrl;
  if (fanficUrl) {
    tasks.push(
      (async () => {
        try {
          const candidate = await fetchFanficPage(fanficUrl);
          if (candidate) fanficCandidates.push(candidate);
        } catch (error) {
          errors.push(`Sito della fanfic: ${(error as Error).message}`);
        }
      })(),
    );
  }

  const queries = buildQuery(book);
  if (!queries.google && !queries.openlibrary) {
    await Promise.allSettled(tasks);
    return { candidates: fanficCandidates, errors };
  }

  // Se il libro ha una lingua nota usiamo quella: filtrare un libro inglese
  // con langRestrict=it restituirebbe zero risultati.
  const googleLanguage = toIso6391(clean(book.language ?? '')) ?? (language || undefined);

  if (providers.includes('googlebooks') && queries.google) {
    tasks.push(
      (async () => {
        try {
          const relevant = relevantTo(book);
          const inLanguage = (candidate: MetadataCandidate) =>
            googleLanguage &&
            String(candidate.fields.language ?? '').toLowerCase().startsWith(googleLanguage)
              ? 0
              : 1;
          let results = await searchGoogleBooks(
            queries.google,
            20,
            options.googleBooksApiKey,
            relevant,
          );
          // Se "titolo autore" non trova nulla di pertinente (es. autore
          // scritto "Cognome, Nome"), riproviamo con il solo titolo.
          if (results.length === 0 && queries.googleFallback) {
            results = await searchGoogleBooks(
              queries.googleFallback,
              20,
              options.googleBooksApiKey,
              relevant,
            );
          }
          candidates.push(
            ...results
              .sort(
                (left, right) =>
                  scoreCandidate(book, right) - scoreCandidate(book, left) ||
                  // A parita' di punteggio: prima le edizioni nella lingua del
                  // libro, poi quelle con la sinossi piu' ricca.
                  inLanguage(left) - inLanguage(right) ||
                  String(right.fields.description ?? '').length -
                    String(left.fields.description ?? '').length,
              )
              .slice(0, 6),
          );
        } catch (error) {
          errors.push(`Google Books: ${(error as Error).message}`);
        }
      })(),
    );
  }
  if (providers.includes('openlibrary') && queries.openlibrary) {
    tasks.push(
      (async () => {
        try {
          let results = await searchOpenLibrary(queries.openlibrary, 6);
          if (results.length === 0 && queries.openlibraryFallback) {
            results = await searchOpenLibrary(queries.openlibraryFallback, 6);
          }
          candidates.push(...results);
        } catch (error) {
          errors.push(`Open Library: ${(error as Error).message}`);
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);

  // Deduplica per provider + titolo simile. I dati della pagina della fanfic
  // restano in testa: sono la fonte piu' affidabile per una fanfic.
  const allCandidates = [...fanficCandidates, ...candidates];
  const seen = new Set<string>();
  const unique = allCandidates.filter((candidate) => {
    const key = `${candidate.provider}:${clean(String(candidate.fields.title ?? '')).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { candidates: unique, errors };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Indice di somiglianza fra due titoli (Dice semplificato). */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const setA = new Set(a.split(' '));
  const setB = new Set(b.split(' '));
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

/** Assegna un punteggio a un candidato rispetto ai dati gia' noti. */
export function scoreCandidate(current: Partial<BookMeta>, candidate: MetadataCandidate): number {
  let score = 0;
  const title = normalize(current.title ?? '');
  const candidateTitle = normalize(String(candidate.fields.title ?? ''));
  if (title && candidateTitle) {
    if (title === candidateTitle) score += 60;
    else if (title.includes(candidateTitle) || candidateTitle.includes(title)) score += 35;
    else if (similarity(title, candidateTitle) > 0.6) score += 20;
  }

  const author = normalize(current.authors?.[0] ?? '');
  const candidateAuthor = normalize((candidate.fields.authors ?? [])[0] ?? '');
  if (author && candidateAuthor) {
    if (author === candidateAuthor) score += 25;
    else if (author.includes(candidateAuthor) || candidateAuthor.includes(author)) score += 12;
  }

  const isbn = normalize(current.isbn ?? '');
  const candidateIsbn = normalize(String(candidate.fields.isbn ?? ''));
  if (isbn && candidateIsbn && isbn === candidateIsbn) score += 80;

  return score;
}

/**
 * Filtro per la ricerca a testo libero: tiene i risultati il cui titolo
 * somiglia a quello del libro, o con lo stesso ISBN. Senza titolo noto non
 * filtra nulla.
 */
function relevantTo(book: Partial<BookMeta>): (candidate: MetadataCandidate) => boolean {
  const title = normalize(book.title ?? '');
  if (!title) return () => true;
  const isbn = normalize(book.isbn ?? '');
  return (candidate) => {
    const candidateTitle = normalize(String(candidate.fields.title ?? ''));
    const candidateIsbn = normalize(String(candidate.fields.isbn ?? ''));
    if (isbn && candidateIsbn === isbn) return true;
    // Non basta l'autore uguale ("Does It Hurt?" non e' "Haunting Adeline").
    // Un titolo in un alfabeto non latino si normalizza in "": va scartato,
    // altrimenti `title.includes('')` lo farebbe passare.
    if (!candidateTitle) return false;
    return (
      candidateTitle === title ||
      candidateTitle.includes(title) ||
      title.includes(candidateTitle) ||
      similarity(title, candidateTitle) > 0.6
    );
  };
}

/** Sceglie il candidato piu' affine, se supera la soglia di sicurezza. */
export function pickBestCandidate(
  current: Partial<BookMeta>,
  candidates: MetadataCandidate[],
  threshold = 70,
): MetadataCandidate | null {
  let best: MetadataCandidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreCandidate(current, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= threshold ? best : null;
}
