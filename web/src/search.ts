import type { BookSummary } from '@shared/types';

/** Minuscole e senza accenti: «Città» e «citta» si equivalgono. */
export function foldText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function queryTokens(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean);
}

/** Testo in cui cercare: tutti i campi, come il filtro di sempre. */
function haystackOf(book: BookSummary): string {
  return foldText(
    [
      book.title,
      book.subtitle,
      book.authors.join(' '),
      book.series,
      book.fandom,
      book.tags.join(' '),
      book.publisher,
      book.description,
      book.isbn,
    ].join(' '),
  );
}

/** Ogni parola della ricerca deve comparire in almeno un campo. */
export function matchesQuery(book: BookSummary, query: string): boolean {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const haystack = haystackOf(book);
  return tokens.every((token) => haystack.includes(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Livello di corrispondenza dell'intera ricerca in un campo: 4 identico ... 1 contenuta. */
function phraseLevel(field: string, phrase: string): number {
  if (!field || !phrase) return 0;
  if (field === phrase) return 4;
  if (field.startsWith(phrase)) return 3;
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}`, 'u').test(field)) return 2;
  return field.includes(phrase) ? 1 : 0;
}

/** Livello di una singola parola: 2 se inizia una parola del campo, 1 se e' contenuta. */
function tokenLevel(field: string, token: string): number {
  if (!field) return 0;
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(token)}`, 'u').test(field)) return 2;
  return field.includes(token) ? 1 : 0;
}

const TITLE_PHRASE = [0, 550, 650, 800, 1000];
const AUTHOR_PHRASE = [0, 350, 400, 450, 500];

/**
 * Pertinenza di un libro per la ricerca: prima il titolo, poi l'autore, poi gli
 * altri campi. Piu' alto e' meglio; 0 se la ricerca e' vuota.
 */
export function searchScore(book: BookSummary, query: string): number {
  const phrase = foldText(query);
  if (!phrase) return 0;
  const title = foldText(book.title);
  const fullTitle = foldText([book.title, book.subtitle].filter(Boolean).join(' '));
  const authors = book.authors.map(foldText);
  const series = foldText(book.series);
  const others = foldText([book.fandom, book.tags.join(' '), book.publisher].join(' '));

  let score = Math.max(
    TITLE_PHRASE[phraseLevel(title, phrase)],
    // Il sottotitolo conta un po' meno del titolo.
    TITLE_PHRASE[phraseLevel(fullTitle, phrase)] * 0.9,
  );
  score += Math.max(0, ...authors.map((author) => AUTHOR_PHRASE[phraseLevel(author, phrase)]));

  // Ricerche di piu' parole ("rina kent malice"): ogni parola trovata conta.
  for (const token of queryTokens(query)) {
    score += [0, 25, 40][tokenLevel(fullTitle, token)];
    score += Math.max(0, ...authors.map((author) => [0, 15, 30][tokenLevel(author, token)]));
    score += [0, 5, 10][tokenLevel(series, token)];
    score += [0, 1, 2][tokenLevel(others, token)];
  }
  return score;
}
