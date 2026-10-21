/**
 * Generi canonici, ricavati dai tag (spesso confusi, in italiano e in inglese,
 * a volte presi da AO3). Ogni tag, in minuscolo, viene confrontato con le
 * espressioni regolari di ogni genere: un tag puo' contare per piu' generi
 * (es. «romantasy»), un libro conta una volta sola per genere.
 */

interface GenreRule {
  name: string;
  patterns: RegExp[];
}

export const GENRE_RULES: GenreRule[] = [
  {
    name: 'Fantasy',
    patterns: [
      /\bfantasy\b/,
      /\bromantasy\b/,
      /fantastico/,
      /^magic$/,
      /^magia$/,
      /^(wizards?|witches|dragons|fairies)$/,
    ],
  },
  {
    // «dark romance» ha un genere a parte e non conta anche come Romance.
    name: 'Romance',
    patterns: [
      /^(?!dark romance$)(?:.*\b)?romance\b/,
      /\bromantasy\b/,
      /^romantic(?:o|a)?(?: fiction| comedy)?$/,
      /^rom-?com$/,
      /^romantic suspense$/,
      /^love (?:stor(?:y|ies)|& romance)$/,
      /^love$/,
      /sentimentale/,
    ],
  },
  { name: 'Dark romance', patterns: [/^dark romance$/] },
  {
    name: 'Fantascienza',
    patterns: [
      /science fiction/,
      /\bsci-?fi\b/,
      /fantascienza/,
      /space opera/,
      /dystopi(?:a|an|c)/,
      /distopi(?:a|co|ca)/,
    ],
  },
  {
    name: 'Thriller e gialli',
    patterns: [
      /\bthrillers?\b/,
      /^mystery$/,
      /\bmysteries\b/,
      /\bgiallo\b/,
      /^crime$/,
      /\bsuspense\b/,
      /poliziesco/,
      /\bnoir\b/,
      /\bdetective\b/,
    ],
  },
  { name: 'Horror', patterns: [/\bhorror\b/] },
  {
    name: 'Paranormale',
    patterns: [
      /^paranormal(?:e)?(?: romance)?$/,
      /^vampir(?:e|es|i|o)$/,
      />\s*vampiri$/,
      /^werewol(?:f|ves)$/,
      /^(?:shifters?|lupi mannari)$/,
      /^(?:soprannaturale|sovrannaturale|supernatural)$/,
    ],
  },
  {
    name: 'Young adult',
    patterns: [/young adult/, /^ya$/, /adolescent/, /^teen(?:s|agers?)?$/],
  },
  {
    name: 'Ragazzi',
    patterns: [/\bchildren/, /\bjuvenile\b/, /\bragazzi\b/, /middle grade/],
  },
  {
    name: 'Storico',
    patterns: [/historical fiction/, /^historical(?: romance)?$/, /\bstorico\b/, /\bstorica\b/],
  },
  {
    name: 'Contemporaneo',
    patterns: [/\bcontemporary\b/, /\bcontemporaneo\b/, /slice of life/],
  },
  {
    name: 'LGBTQ+',
    patterns: [
      /\blgbt/,
      /\bqueer\b/,
      /^m\/m$/,
      /^f\/f$/,
      /\bgay\b/,
      /\blesbian/,
      /^slash$/,
      /^(?:shonen-ai|shounen-ai|yaoi|yuri)$/,
    ],
  },
  {
    name: 'Commedia',
    patterns: [/\bhumou?r(?:ous)?\b/, /\bcomedy\b/, /\bcommedia\b/, /\bcomico\b/, /umoristico/],
  },
  {
    name: 'Avventura',
    patterns: [/\badventure\b/, /\bavventura\b/, /\bazione\b/, /^action\b/],
  },
  {
    name: 'Drammatico',
    patterns: [
      /^drama$/,
      /\bdrammatico\b/,
      /(?<!no )\bangst\b/,
      /introspettivo/,
      /malinconico/,
      /\btrag(?:edia|edy)\b/,
    ],
  },
  {
    name: 'Letteratura e classici',
    patterns: [
      /^(?:american|english|italian|french|german|russian|world|modern)? ?literature$/,
      /\bletteratura\b/,
      /^literary(?: fiction)?$/,
      /\bclassic(?:s|i|o|al)?\b/,
    ],
  },
  {
    // Solo «non-fiction» intero: «science fiction» o «fiction» non c'entrano.
    name: 'Saggistica',
    patterns: [
      /^non-?fiction$/,
      /saggistica/,
      /^saggio$/,
      /self-help/,
      /^psicolog/,
      /^psychology$/,
      /^business\b/,
      /^biograf/,
      /^biograph/,
      /^memoirs?$/,
      /^filosof/,
      /^philosophy$/,
    ],
  },
  { name: 'Poesia', patterns: [/\bpoetry\b/, /\bpoesia\b/, /\bpoesie\b/, /\bpoems\b/] },
  { name: 'Erotico', patterns: [/\berotic(?:a|o)?\b/, /\bsmut\b/] },
];

/** Un tag con nome di personaggio o fandom («Loki (Marvel)») o coppia («A/B») non e' un genere. */
function isIgnorable(tag: string): boolean {
  if (tag.includes('(') || tag.includes('|')) return true;
  // Le AU di AO3 («Alternate Universe - Science Fiction») non descrivono il libro.
  if (tag.startsWith('alternate universe')) return true;
  return tag.includes('/') && !/^[mf]\/[mf]$/.test(tag);
}

/** Generi (distinti) a cui corrisponde un singolo tag. */
export function tagGenres(tag: string): string[] {
  const value = tag.trim().toLowerCase();
  if (!value || isIgnorable(value)) return [];
  return GENRE_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(value))).map(
    (rule) => rule.name,
  );
}

/** Generi distinti di un libro, nell'ordine della tabella. */
export function bookGenres(tags: string[]): string[] {
  const found = new Set<string>();
  for (const tag of tags) {
    for (const genre of tagGenres(tag)) found.add(genre);
  }
  return GENRE_RULES.map((rule) => rule.name).filter((name) => found.has(name));
}

export interface UnmappedTag {
  tag: string;
  count: number;
}

/** I tag piu' frequenti (per numero di libri) che non corrispondono a nessun genere. */
export function unmappedTags(books: { tags: string[] }[], n: number): UnmappedTag[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const book of books) {
    const seen = new Set<string>();
    for (const raw of book.tags) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (tagGenres(tag).length > 0) continue;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'it'))
    .slice(0, n);
}
