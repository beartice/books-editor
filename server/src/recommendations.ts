import type {
  BookMeta,
  TasteItem,
  BookRecommendation,
  RecommendationReason,
  RecommendationsResult,
} from '../../shared/types.js';
import { bookGenres } from '../../shared/genres.js';
import { htmlToText } from './htmlText.js';
import { toIso6391 } from './language.js';
import { cleanIncomingTags } from './tagRules.js';

/*
 * «Cosa leggere dopo»: suggerimenti pescati solo fra i libri non letti della
 * libreria. Niente servizi esterni ne' IA: il gusto dell'utente si ricava da
 * voti, preferiti e abbandoni, e si confronta con autore, tag, fandom, trama
 * e abitudini di ogni libro non letto. Funzioni pure, senza I/O.
 */

/* ------------------------------------------------------------- costanti -- */

/** Gradimento di un voto (stelle) -> valore da -1 a +1. */
const RATING_SIGNAL: { min: number; value: number }[] = [
  { min: 5, value: 1 },
  { min: 4.5, value: 0.8 },
  { min: 4, value: 0.5 },
  { min: 3.5, value: 0.15 },
  { min: 3, value: -0.1 },
  { min: 2.5, value: -0.4 },
  { min: 0, value: -0.7 },
];
const SIGNAL_READ_UNRATED = 0.3;
const SIGNAL_FAVORITE_BONUS = 0.5;
const SIGNAL_MAX = 1.2;
const SIGNAL_DNF = -1;
const SIGNAL_READING_ADVANCED = 0.2;
/** Avanzamento da cui un libro «in lettura» senza voto conta come gradito. */
const READING_MIN_PROGRESS = 50;
const SIGNAL_DISMISSED = -0.4;

/** Meno libri con un segnale di questo tipo e non si propone nulla. */
const MIN_SIGNAL_BOOKS = 5;

/** Restringimento verso zero: peso = somma / (conteggio + k). */
const SHRINK_AUTHOR = 1;
const SHRINK_FEATURE = 2;
/** Costante al denominatore dei punteggi di tag e fandom: pochi tag in comune non dominano. */
const SMOOTH_FEATURES = 2;

/** Pesi dei segnali nel punteggio finale. */
const WEIGHT_AUTHOR = 1;
const WEIGHT_TAGS = 1;
const WEIGHT_FANDOM = 0.6;
const WEIGHT_PLOT = 1;
const WEIGHT_HABITS = 0.1;

/** La somiglianza di trama (coseno, 0-1) e' piccola: la si porta alla scala degli altri segnali. */
const PLOT_SCALE = 4;
const PLOT_NEIGHBORS = 5;
const PLOT_MIN_TOKEN = 3;

/** Abitudini: restringimenti e penalita'. */
const SHRINK_HABIT = 5;
const LANGUAGE_NEVER_FINISHED = -0.5;
const LANGUAGE_NEVER_FINISHED_MIN_BOOKS = 2;
/** Fasce di lunghezza (parole): estremi superiori, l'ultima fascia e' aperta. */
const LENGTH_BANDS = [15000, 50000, 100000, 200000];
const BAND_SCALE = 2;

/** Soglie per scrivere una motivazione. */
const REASON_AUTHOR_MIN = 0.15;
const REASON_TAGS_MIN = 0.1;
const REASON_FANDOM_MIN = 0.1;
const REASON_PLOT_MIN_SIMILARITY = 0.2;
const REASON_BOOK_MIN_LIKE = 0.3;
const CAUTION_BOOK_MAX_LIKE = -0.7;
const CAUTION_TAGS_MAX = -0.15;
const REASON_MAX = 3;
const REASON_FEATURES = 3;
/** Un tag presente in piu' di questa quota dei libri non si cita nelle motivazioni. */
const REASON_TAG_MAX_SHARE = 0.15;
/** Rating e categorie AO3: non dicono nulla di specifico sul gusto. */
const REASON_SKIP_TAGS = new Set([
  'mature',
  'explicit',
  'teen and up audiences',
  'general audiences',
  'not rated',
  'm/m',
  'f/m',
  'f/f',
  'gen',
  'multi',
  'other',
]);

/** Limiti dell'elenco «Scelti per te». */
export const DEFAULT_RECOMMENDATION_LIMIT = 15;
export const MAX_RECOMMENDATION_LIMIT = 100;
const MAX_PER_AUTHOR = 2;
const MAX_PER_FANDOM = 3;
const MAX_PER_SHIP = 3;
const SERIES_MIN_AVERAGE = 3;

/** Tag che non dicono nulla sul gusto (gia' in minuscolo, senza accenti). */
const GENERIC_TAGS = new Set([
  'fiction',
  'general',
  'fiction general',
  'narrativa',
  'ebook',
  'book',
  'books',
  'novel',
  'novels',
  'literature',
  'fanworks',
  'new york times bestseller',
  'american literature',
  'no archive warnings apply',
  'choose not to use archive warnings',
  'creator chose not to use archive warnings',
  'non specificato',
  'unspecified',
]);

/** Parole poco informative nelle trame (italiano, inglese, francese, spagnolo). */
const STOPWORDS = new Set(
  (
    'il lo la le gli un una uno di del della dei delle degli che chi non per con come ma anche una sono era ' +
    'nel nella nei dalla dal alla alle suo sua sui sul questo questa tra fra poi solo ' +
    'the and for with that this from his her their they was were has had have not but are its who which when ' +
    'into out all one about after before over than then what will would can been being him she you your ' +
    'les des une est dans pour que qui pas par sur son ses ils elles avec mais aux ce cette ' +
    'los las del por con para una que sus como pero mas muy este esta'
  ).split(/\s+/),
);

export type SignalName = 'author' | 'tags' | 'fandom' | 'plot' | 'habits';
export const SIGNAL_NAMES: readonly SignalName[] = ['author', 'tags', 'fandom', 'plot', 'habits'];

const SIGNAL_WEIGHT: Record<SignalName, number> = {
  author: WEIGHT_AUTHOR,
  tags: WEIGHT_TAGS,
  fandom: WEIGHT_FANDOM,
  plot: WEIGHT_PLOT,
  habits: WEIGHT_HABITS,
};

/* ------------------------------------------------------- gradimento -- */

/** Gradimento di un libro da -1 a +1.2; null se non dice nulla sul gusto (non letto, non scartato). */
export function likeSignal(book: BookMeta): number | null {
  if (book.readingStatus === 'unread') {
    return book.recommendationDismissed ? SIGNAL_DISMISSED : null;
  }
  if (book.readingStatus === 'dnf') return SIGNAL_DNF;
  let base: number;
  if (book.rating !== null && book.rating !== undefined) {
    base = (RATING_SIGNAL.find((step) => book.rating! >= step.min) ?? RATING_SIGNAL[RATING_SIGNAL.length - 1]).value;
  } else if (book.readingStatus === 'reading') {
    base = (book.readingProgress ?? 0) >= READING_MIN_PROGRESS ? SIGNAL_READING_ADVANCED : 0;
  } else {
    base = SIGNAL_READ_UNRATED;
  }
  if (book.favorite) base = Math.min(SIGNAL_MAX, base + SIGNAL_FAVORITE_BONUS);
  return base;
}

function isFinished(book: BookMeta): boolean {
  return book.readingStatus === 'read' || book.readingStatus === 'reread';
}

/* ------------------------------------------------------ normalizzazione -- */

/** Minuscolo, senza accenti, spazi uniformati. */
function norm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Autori che non identificano una persona: due opere «Anonymous» non sono dello stesso autore. */
const ANONYMOUS_AUTHORS = new Set([
  'unknown',
  'sconosciuto',
  'autore sconosciuto',
  'anonymous',
  'anonimo',
  'anon',
  'orphan_account',
  'orphan account',
]);

function isAnonymousAuthor(key: string): boolean {
  return ANONYMOUS_AUTHORS.has(key);
}

/** Primo autore riconoscibile ('' se manca o e' anonimo: nessun limite per autore). */
function firstAuthor(book: BookMeta): string {
  const key = norm((book.authors ?? [])[0] ?? '');
  return isAnonymousAuthor(key) ? '' : key;
}

export function seriesKey(book: BookMeta): string {
  return norm(book.series ?? '');
}

function lengthBand(book: BookMeta): number | null {
  const words = book.wordCount;
  if (!words || words <= 0) return null;
  const band = LENGTH_BANDS.findIndex((limit) => words <= limit);
  return band === -1 ? LENGTH_BANDS.length : band;
}

function tokenize(text: string): string[] {
  return norm(text)
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length >= PLOT_MIN_TOKEN && !STOPWORDS.has(word));
}

/* -------------------------------------------------------------- corpus -- */

interface Features {
  book: BookMeta;
  /** Chiave -> grafia originale, per gruppo di caratteristiche. */
  authors: Map<string, string>;
  tags: Map<string, string>;
  fandom: Map<string, string>;
  /** Vettore TF-IDF normalizzato della trama, null senza descrizione utile. */
  plot: Map<string, number> | null;
  language: string;
  band: number | null;
}

/** Caratteristiche di tutti i libri e pesi IDF: non dipende da voti e stati. */
export interface Corpus {
  features: Map<string, Features>;
  idf: (key: string) => number;
  /** Quota dei libri (0-1) che hanno la caratteristica. */
  share: (key: string) => number;
  languageCount: Map<string, number>;
}

function addAll(target: Map<string, string>, prefix: string, values: string[] | undefined): void {
  for (const raw of values ?? []) {
    const label = (raw ?? '').trim();
    const key = norm(label);
    if (key && !target.has(prefix + key)) target.set(prefix + key, label);
  }
}

function extractFeatures(book: BookMeta): Features {
  const authors = new Map<string, string>();
  for (const author of book.authors ?? []) {
    const key = norm(author ?? '');
    if (key && !isAnonymousAuthor(key)) authors.set(`a:${key}`, author.trim());
  }

  const tags = new Map<string, string>();
  const usable = (book.tags ?? []).filter((tag) => tag && !GENERIC_TAGS.has(norm(tag)));
  addAll(tags, 't:', usable);
  for (const genre of bookGenres(book.tags ?? [])) tags.set(`g:${norm(genre)}`, genre);

  const fandom = new Map<string, string>();
  addAll(fandom, 'f:', book.fandom ? [book.fandom] : []);
  addAll(fandom, 's:', [...(book.ships ?? []), ...(book.relationships ?? [])]);
  addAll(fandom, 'c:', book.characters);

  return {
    book,
    authors,
    tags,
    fandom,
    plot: null,
    language: toIso6391(book.language ?? '') ?? '',
    band: lengthBand(book),
  };
}

/** Prepara le caratteristiche e i pesi IDF su tutti i libri indicati. */
export function buildCorpus(books: BookMeta[]): Corpus {
  const features = new Map<string, Features>();
  const df = new Map<string, number>();
  const languageCount = new Map<string, number>();
  const bump = (key: string) => df.set(key, (df.get(key) ?? 0) + 1);

  for (const book of books) {
    const item = extractFeatures(book);
    features.set(book.id, item);
    for (const key of [...item.authors.keys(), ...item.tags.keys(), ...item.fandom.keys()]) bump(key);
    if (item.language) languageCount.set(item.language, (languageCount.get(item.language) ?? 0) + 1);
  }

  // Trame: TF-IDF sulle sole parole presenti in almeno due descrizioni.
  const termCounts = new Map<string, Map<string, number>>();
  const termDf = new Map<string, number>();
  for (const book of books) {
    const words = tokenize(htmlToText(book.description));
    if (words.length < 5) continue;
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    termCounts.set(book.id, counts);
    for (const word of counts.keys()) termDf.set(word, (termDf.get(word) ?? 0) + 1);
  }
  const documents = termCounts.size;
  for (const [id, counts] of termCounts) {
    const vector = new Map<string, number>();
    let squares = 0;
    for (const [word, count] of counts) {
      const frequency = termDf.get(word) ?? 0;
      if (frequency < 2) continue;
      const weight = (1 + Math.log(count)) * Math.log(documents / frequency);
      if (weight <= 0) continue;
      vector.set(word, weight);
      squares += weight * weight;
    }
    if (!vector.size) continue;
    const length = Math.sqrt(squares);
    for (const [word, weight] of vector) vector.set(word, weight / length);
    features.get(id)!.plot = vector;
  }

  const total = books.length;
  const idf = (key: string) => {
    const frequency = df.get(key) ?? 0;
    // Una caratteristica presente in un solo libro non lega nulla.
    return frequency >= 2 ? Math.log(total / frequency) : 0;
  };
  const share = (key: string) => (total > 0 ? (df.get(key) ?? 0) / total : 0);
  return { features, idf, share, languageCount };
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [word, weight] of small) {
    const other = large.get(word);
    if (other !== undefined) dot += weight * other;
  }
  return dot;
}

/* ------------------------------------------------------------- profilo -- */

interface ProfileItem {
  book: BookMeta;
  features: Features;
  like: number;
}

interface FeatureStat {
  /** Peso del profilo: somma dei gradimenti / (conteggio + k). */
  weight: number;
  holders: ProfileItem[];
}

interface Profile {
  items: ProfileItem[];
  authors: Map<string, FeatureStat>;
  tags: Map<string, FeatureStat>;
  fandom: Map<string, FeatureStat>;
  /** Lingua -> [finiti, abbandonati]. */
  languages: Map<string, [number, number]>;
  /** Fascia di lunghezza -> [finiti, abbandonati]. */
  bands: Map<number, [number, number]>;
  baseAbandonRate: number;
}

function groupStats(
  items: ProfileItem[],
  pick: (item: ProfileItem) => Map<string, string>,
  shrink: number,
): Map<string, FeatureStat> {
  const sums = new Map<string, { sum: number; holders: ProfileItem[] }>();
  for (const item of items) {
    for (const key of pick(item).keys()) {
      const entry = sums.get(key) ?? { sum: 0, holders: [] };
      entry.sum += item.like;
      entry.holders.push(item);
      sums.set(key, entry);
    }
  }
  const stats = new Map<string, FeatureStat>();
  for (const [key, { sum, holders }] of sums) {
    stats.set(key, { weight: sum / (holders.length + shrink), holders });
  }
  return stats;
}

function buildProfile(corpus: Corpus, profileBooks: BookMeta[]): Profile {
  const items: ProfileItem[] = [];
  for (const book of profileBooks) {
    const like = likeSignal(book);
    const features = corpus.features.get(book.id);
    if (like === null || like === 0 || !features) continue;
    items.push({ book, features, like });
  }
  const languages = new Map<string, [number, number]>();
  const bands = new Map<number, [number, number]>();
  let finished = 0;
  let abandoned = 0;
  for (const book of profileBooks) {
    const features = corpus.features.get(book.id);
    if (!features) continue;
    const done = isFinished(book);
    const dropped = book.readingStatus === 'dnf';
    if (!done && !dropped) continue;
    if (done) finished += 1;
    else abandoned += 1;
    const slot = done ? 0 : 1;
    if (features.language) {
      const entry = languages.get(features.language) ?? [0, 0];
      entry[slot] += 1;
      languages.set(features.language, entry);
    }
    if (features.band !== null) {
      const entry = bands.get(features.band) ?? [0, 0];
      entry[slot] += 1;
      bands.set(features.band, entry);
    }
  }

  return {
    items,
    authors: groupStats(items, (item) => item.features.authors, SHRINK_AUTHOR),
    tags: groupStats(items, (item) => item.features.tags, SHRINK_FEATURE),
    fandom: groupStats(items, (item) => item.features.fandom, SHRINK_FEATURE),
    languages,
    bands,
    baseAbandonRate: finished + abandoned > 0 ? abandoned / (finished + abandoned) : 0,
  };
}

/* ------------------------------------------------------------ punteggio -- */

export interface ScoreOptions {
  /** Segnali da usare (tutti, se omesso); `false` spegne il singolo segnale. */
  signals?: Partial<Record<SignalName, boolean>>;
}

interface Contribution {
  /** Chiave con prefisso del gruppo (`f:` fandom, `s:` coppia, `c:` personaggio...). */
  key: string;
  label: string;
  value: number;
  /** Quota dei libri con la caratteristica (0-1). */
  share: number;
  stat: FeatureStat;
}

interface Detail {
  authorHits: ProfileItem[];
  tags: Contribution[];
  fandom: Contribution[];
  plotLiked: { item: ProfileItem; similarity: number }[];
}

export interface ScoredCandidate {
  book: BookMeta;
  score: number;
  parts: Record<SignalName, number>;
  detail: Detail;
}

/** Punteggio di un gruppo di caratteristiche: media pesata IDF dei pesi del profilo. */
function featureScore(
  corpus: Corpus,
  own: Map<string, string>,
  stats: Map<string, FeatureStat>,
  weighted: boolean,
): { score: number; contributions: Contribution[] } {
  let numerator = 0;
  let known = 0;
  const contributions: Contribution[] = [];
  for (const [key, label] of own) {
    const stat = stats.get(key);
    if (!stat) continue;
    const weight = weighted ? corpus.idf(key) : 1;
    if (weight <= 0) continue;
    numerator += weight * stat.weight;
    known += weight;
    contributions.push({ key, label, value: weight * stat.weight, share: corpus.share(key), stat });
  }
  const score = known > 0 ? numerator / (known + (weighted ? SMOOTH_FEATURES : 0)) : 0;
  return { score, contributions };
}

function habitScore(corpus: Corpus, profile: Profile, features: Features): number {
  let languagePart = 0;
  if (features.language) {
    const [done, dropped] = profile.languages.get(features.language) ?? [0, 0];
    if (done === 0 && (corpus.languageCount.get(features.language) ?? 0) >= LANGUAGE_NEVER_FINISHED_MIN_BOOKS) {
      languagePart = LANGUAGE_NEVER_FINISHED;
    } else {
      languagePart = (done - dropped) / (done + dropped + SHRINK_HABIT);
    }
  }
  let bandPart = 0;
  if (features.band !== null) {
    const [done, dropped] = profile.bands.get(features.band) ?? [0, 0];
    const rate = (dropped + SHRINK_HABIT * profile.baseAbandonRate) / (done + dropped + SHRINK_HABIT);
    bandPart = -(rate - profile.baseAbandonRate) * BAND_SCALE;
  }
  return (languagePart + bandPart) / 2;
}

/**
 * Punteggia i candidati rispetto al gusto ricavato da `profileBooks` (libri con
 * voto, stato o preferito). I candidati non entrano mai nel profilo, anche se
 * compaiono fra i `profileBooks`: cosi' la valutazione puo' trattare i libri di
 * test come mai letti. Ordine dei risultati: quello dei candidati.
 */
export function scoreCandidates(
  corpus: Corpus,
  profileBooks: BookMeta[],
  candidates: BookMeta[],
  options: ScoreOptions = {},
): ScoredCandidate[] {
  const candidateIds = new Set(candidates.map((book) => book.id));
  const profile = buildProfile(corpus, profileBooks.filter((book) => !candidateIds.has(book.id)));
  const enabled = (name: SignalName) => options.signals?.[name] !== false;
  const liked = profile.items.filter((item) => item.like > 0 && item.features.plot);
  const disliked = profile.items.filter((item) => item.like < 0 && item.features.plot);

  const result: ScoredCandidate[] = [];
  for (const book of candidates) {
    const features = corpus.features.get(book.id);
    if (!features) continue;

    const author = featureScore(corpus, features.authors, profile.authors, false);
    const tags = featureScore(corpus, features.tags, profile.tags, true);
    const fandom = featureScore(corpus, features.fandom, profile.fandom, true);

    // Trama: i libri graditi piu' simili meno gli sgraditi piu' simili.
    let plot = 0;
    let plotLiked: { item: ProfileItem; similarity: number }[] = [];
    if (features.plot) {
      const neighbors = (pool: ProfileItem[]) =>
        pool
          .filter((item) => item.book.id !== book.id)
          .map((item) => ({ item, similarity: cosine(features.plot!, item.features.plot!) }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, PLOT_NEIGHBORS);
      const mean = (list: { similarity: number }[]) =>
        list.length ? list.reduce((sum, entry) => sum + entry.similarity, 0) / list.length : 0;
      plotLiked = neighbors(liked);
      plot = (mean(plotLiked) - mean(neighbors(disliked))) * PLOT_SCALE;
    }

    const parts: Record<SignalName, number> = {
      author: author.score,
      tags: tags.score,
      fandom: fandom.score,
      plot,
      habits: habitScore(corpus, profile, features),
    };
    let score = 0;
    for (const name of SIGNAL_NAMES) if (enabled(name)) score += SIGNAL_WEIGHT[name] * parts[name];

    result.push({
      book,
      score,
      parts,
      detail: {
        authorHits: author.contributions.flatMap((entry) => entry.stat.holders),
        tags: tags.contributions,
        fandom: fandom.contributions,
        plotLiked,
      },
    });
  }
  return result;
}

/* ---------------------------------------------------------- motivazioni -- */

const quote = (book: BookMeta) => `«${book.title}»`;

function stars(rating: number): string {
  return `${String(rating).replace('.', ',')}★`;
}

/** «(5★)», «(preferito)» o «(letto)»: come l'utente ha giudicato il libro. */
function verdict(book: BookMeta): string {
  if (book.rating !== null && book.rating !== undefined) return stars(book.rating);
  if (book.favorite) return 'preferito';
  return 'letto';
}

function joinTitles(books: BookMeta[]): string {
  const names = books.map(quote);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

/** Libri del profilo (ben voluti) che condividono di piu' le caratteristiche indicate. */
function topHolders(contributions: Contribution[], positive: boolean, count: number): BookMeta[] {
  const scores = new Map<string, { item: ProfileItem; value: number }>();
  for (const contribution of contributions) {
    for (const item of contribution.stat.holders) {
      if (positive ? item.like < REASON_BOOK_MIN_LIKE : item.like > CAUTION_BOOK_MAX_LIKE) continue;
      const entry = scores.get(item.book.id) ?? { item, value: 0 };
      entry.value += 1 + Math.abs(item.like) / 10;
      scores.set(item.book.id, entry);
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, count)
    .map((entry) => entry.item.book);
}

interface BuiltReasons {
  reasons: RecommendationReason[];
  /** Almeno una motivazione positiva specifica (non solo un avvertimento). */
  specific: boolean;
  /** C'e' la motivazione «stesso autore». */
  author: boolean;
}

function buildReasons(scored: ScoredCandidate): BuiltReasons {
  const { parts, detail } = scored;
  const positives: { value: number; reason: RecommendationReason }[] = [];
  const cautions: RecommendationReason[] = [];

  // Autore: il libro piu' apprezzato dello stesso autore; attenzione se ne hai scartato uno.
  const sameAuthor = detail.authorHits;
  const bestAuthor = [...sameAuthor].sort((a, b) => b.like - a.like)[0];
  if (bestAuthor && bestAuthor.like >= REASON_BOOK_MIN_LIKE && parts.author >= REASON_AUTHOR_MIN) {
    positives.push({
      value: parts.author,
      reason: {
        kind: 'author',
        text: `Stesso autore di ${quote(bestAuthor.book)} (${verdict(bestAuthor.book)})`,
      },
    });
  }
  const worstAuthor = [...sameAuthor].sort((a, b) => a.like - b.like)[0];
  if (worstAuthor && worstAuthor.like <= CAUTION_BOOK_MAX_LIKE) {
    cautions.push({
      kind: 'caution',
      text:
        worstAuthor.book.readingStatus === 'dnf'
          ? `Attenzione: hai abbandonato ${quote(worstAuthor.book)} dello stesso autore`
          : `Attenzione: hai dato ${verdict(worstAuthor.book)} a ${quote(worstAuthor.book)} dello stesso autore`,
    });
  }

  // Fandom, coppia, personaggi.
  const fandomTop = detail.fandom.filter((entry) => entry.value > 0).sort((a, b) => b.value - a.value);
  if (fandomTop.length && parts.fandom >= REASON_FANDOM_MIN) {
    const best = fandomTop[0];
    const sample = topHolders([best], true, 1)[0];
    if (sample) {
      const isFandom = best.key.startsWith('f:');
      const isShip = best.key.startsWith('s:');
      positives.push({
        value: parts.fandom * WEIGHT_FANDOM,
        reason: {
          kind: 'fandom',
          text: isFandom
            ? `Stesso fandom di ${quote(sample)}`
            : isShip
              ? `Stessa coppia di ${quote(sample)}: ${best.label}`
              : `Personaggi in comune con ${quote(sample)}: ${best.label}`,
        },
      });
    }
  }

  // Tag e generi.
  // Un tag che ripete fandom, coppia o personaggio gia' citati nella motivazione del fandom non si ripete.
  const fandomLabels = new Set(detail.fandom.map((entry) => norm(entry.label)));
  // Niente tag troppo comuni ne' rating e categorie AO3: solo testo, il punteggio non cambia.
  const quotable = (entry: Contribution) =>
    entry.share <= REASON_TAG_MAX_SHARE && !REASON_SKIP_TAGS.has(norm(entry.label));
  const tagsTop = detail.tags
    .filter((entry) => entry.value > 0 && quotable(entry) && !fandomLabels.has(norm(entry.label)))
    .sort((a, b) => b.value - a.value);
  if (tagsTop.length && parts.tags >= REASON_TAGS_MIN) {
    const top = tagsTop.slice(0, REASON_FEATURES);
    const holders = topHolders(top, true, 2);
    if (holders.length) {
      positives.push({
        value: parts.tags * WEIGHT_TAGS,
        reason: {
          kind: 'tags',
          text: `Tag in comune con ${joinTitles(holders)}: ${top.map((entry) => entry.label.toLowerCase()).join(', ')}`,
        },
      });
    }
  }
  const tagsBad = detail.tags.filter((entry) => entry.value < 0 && quotable(entry)).sort((a, b) => a.value - b.value);
  if (tagsBad.length && parts.tags <= CAUTION_TAGS_MAX) {
    const top = tagsBad.slice(0, REASON_FEATURES);
    const holders = topHolders(top, false, 2);
    if (holders.length) {
      cautions.push({
        kind: 'caution',
        text: `Attenzione: ha tag in comune con ${joinTitles(holders)}, che non ti è piaciuto: ${top
          .map((entry) => entry.label.toLowerCase())
          .join(', ')}`,
      });
    }
  }

  // Trama.
  const nearest = detail.plotLiked[0];
  if (nearest && nearest.similarity >= REASON_PLOT_MIN_SIMILARITY && nearest.item.like >= REASON_BOOK_MIN_LIKE) {
    positives.push({
      value: parts.plot * WEIGHT_PLOT,
      reason: { kind: 'plot', text: `Trama simile a ${quote(nearest.item.book)}` },
    });
  }

  // Nessuna motivazione specifica: vale solo un genere in comune con un libro gradito.
  if (!positives.length) {
    const sharedGenre = detail.tags.some(
      (entry) => entry.key.startsWith('g:') && entry.value > 0 && entry.stat.holders.some((item) => item.like >= REASON_BOOK_MIN_LIKE),
    );
    if (sharedGenre) {
      positives.push({ value: 0, reason: { kind: 'tags', text: 'Generi vicini a quelli che leggi' } });
    }
  }

  positives.sort((a, b) => b.value - a.value);
  const room = cautions.length ? REASON_MAX - 1 : REASON_MAX;
  const reasons = [...positives.slice(0, room).map((entry) => entry.reason), ...cautions.slice(0, 1)];
  return {
    reasons,
    specific: positives.length > 0,
    author: positives.some((entry) => entry.reason.kind === 'author'),
  };
}

/* --------------------------------------------------------------- serie -- */

/** Libri raggruppati per nome di serie normalizzato (i libri senza serie non compaiono). */
export function groupBySeries(books: BookMeta[]): Map<string, BookMeta[]> {
  const bySeries = new Map<string, BookMeta[]>();
  for (const book of books) {
    const key = seriesKey(book);
    if (!key) continue;
    const list = bySeries.get(key) ?? [];
    list.push(book);
    bySeries.set(key, list);
  }
  return bySeries;
}

/**
 * Il libro e' il volume non letto con l'indice minore della sua serie (o non ha serie).
 * Un volume senza indice vale solo se nessun altro non letto ha un indice. Volumi in lettura,
 * abbandonati o nascosti contano come «non letti»: sbarrano la strada ai successivi.
 */
export function isLowestUnreadVolume(book: BookMeta, bySeries: Map<string, BookMeta[]>): boolean {
  const key = seriesKey(book);
  if (!key) return true;
  const pending = (bySeries.get(key) ?? []).filter((volume) => !isRead(volume));
  const indexes = pending.map((volume) => volume.seriesIndex).filter((index): index is number => index !== null);
  if (book.seriesIndex === null) return indexes.length === 0;
  return book.seriesIndex === Math.min(...indexes);
}

const isRead = (book: BookMeta) => isFinished(book);

/** Il primo volume non letto dopo l'ultimo letto di ogni serie iniziata. */
function seriesNextPicks(
  bySeries: Map<string, BookMeta[]>,
  isCandidate: (book: BookMeta) => boolean,
): BookRecommendation[] {
  const picks: BookRecommendation[] = [];
  for (const [, volumes] of bySeries) {
    const read = volumes.filter(isRead);
    if (!read.length) continue;
    if (volumes.some((book) => book.readingStatus === 'dnf')) continue;
    const rated = volumes.filter((book) => book.rating !== null && book.rating !== undefined);
    if (rated.length && rated.reduce((sum, book) => sum + book.rating!, 0) / rated.length < SERIES_MIN_AVERAGE) {
      continue;
    }

    const readIndexes = read.map((book) => book.seriesIndex).filter((index): index is number => index !== null);
    const lastIndex = readIndexes.length ? Math.max(...readIndexes) : null;
    const notRead = volumes.filter((book) => !isRead(book));
    let target: BookMeta | undefined;
    if (notRead.length === 1) {
      const only = notRead[0];
      if (lastIndex === null || only.seriesIndex === null || only.seriesIndex > lastIndex) target = only;
    } else if (lastIndex !== null) {
      target = notRead
        .filter((book) => book.seriesIndex !== null && book.seriesIndex > lastIndex)
        .sort((a, b) => a.seriesIndex! - b.seriesIndex!)[0];
    }
    if (!target || !isCandidate(target)) continue;
    // Un volume precedente in lettura blocca la proposta.
    if (
      target.seriesIndex !== null &&
      volumes.some(
        (book) => book.readingStatus === 'reading' && book.seriesIndex !== null && book.seriesIndex < target!.seriesIndex!,
      )
    ) {
      continue;
    }

    const lastRead =
      lastIndex === null
        ? read[read.length - 1]
        : read.filter((book) => book.seriesIndex === lastIndex).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
    const seriesName = target.series.trim();
    const missing =
      lastIndex !== null && target.seriesIndex !== null && target.seriesIndex - lastIndex > 1 ? lastIndex + 1 : null;
    const text =
      missing !== null
        ? `Hai letto fino al vol. ${lastIndex} di «${seriesName}»; il vol. ${missing} non è in libreria`
        : `Seguito di ${quote(lastRead)} (${verdict(lastRead)}) nella serie «${seriesName}»`;

    const likes = read.map((book) => likeSignal(book) ?? 0);
    picks.push({
      id: target.id,
      score: likes.reduce((sum, value) => sum + value, 0) / likes.length,
      reasons: [{ kind: 'series', text }],
    });
  }
  return picks.sort((a, b) => b.score - a.score);
}

/* ---------------------------------------------------------------- gusto -- */

const TASTE_LIKED_AUTHORS = 5;
const TASTE_LIKED_TAGS = 6;
const TASTE_DISLIKED = 4;
const TASTE_MIN_BOOKS = 2;
const TASTE_BOOK_IDS = 8;
/** Fascia di lunghezza «da evitare»: libri minimi e scarto dal tasso medio di abbandono. */
const TASTE_BAND_MIN_BOOKS = 5;
const TASTE_BAND_MIN_EXCESS = 0.15;

const words = (value: number) => `${Math.round(value / 1000)}k`;

/** Etichetta di una fascia di `LENGTH_BANDS`. */
function bandLabel(band: number): string {
  if (band === 0) return `Fino a ${words(LENGTH_BANDS[0])} parole`;
  if (band >= LENGTH_BANDS.length) return `Oltre ${words(LENGTH_BANDS[LENGTH_BANDS.length - 1])} parole`;
  return `Da ${words(LENGTH_BANDS[band - 1])} a ${words(LENGTH_BANDS[band])} parole`;
}

/**
 * Cosa pesa nei suggerimenti, dal profilo gia' costruito (nessun segnale nuovo): autori e tag
 * graditi, autori/tag/lunghezza che pesano contro. `bookIds`: i libri che hanno fatto pesare la voce.
 */
function computeTaste(corpus: Corpus, signalBooks: BookMeta[]): RecommendationsResult['taste'] {
  const profile = buildProfile(corpus, signalBooks);
  const ids = (holders: ProfileItem[], liked: boolean) =>
    [...holders]
      .filter((item) => (liked ? item.like > 0 : item.like < 0))
      .sort((a, b) => (liked ? b.like - a.like : a.like - b.like))
      .slice(0, TASTE_BOOK_IDS)
      .map((item) => item.book.id);
  const tagOk = (key: string, label: string) =>
    corpus.share(key) <= REASON_TAG_MAX_SHARE && !REASON_SKIP_TAGS.has(norm(label));
  // Stesse regole della pulizia dei tag: niente «Serie:…», sinonimi al nome canonico, un'etichetta una volta sola.
  const shown = new Set<string>();
  const cleanLabel = (label: string): string | null => {
    const clean = cleanIncomingTags([label])[0];
    if (!clean || shown.has(norm(clean))) return null;
    shown.add(norm(clean));
    return clean;
  };
  const labelOf = (stat: FeatureStat, pick: (item: ProfileItem) => Map<string, string>, key: string) =>
    pick(stat.holders[0]).get(key) ?? key;

  const liked: TasteItem[] = [];
  const authorsLiked = [...profile.authors]
    .filter(([, stat]) => stat.weight > 0 && stat.holders.some((item) => item.like >= REASON_BOOK_MIN_LIKE))
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, TASTE_LIKED_AUTHORS);
  for (const [key, stat] of authorsLiked) {
    liked.push({ kind: 'author', label: labelOf(stat, (item) => item.features.authors, key), bookIds: ids(stat.holders, true) });
  }
  const tagsLiked = [...profile.tags]
    .map(([key, stat]) => ({ key, stat, label: labelOf(stat, (item) => item.features.tags, key) }))
    .filter(({ key, stat, label }) => stat.weight > 0 && stat.holders.length >= TASTE_MIN_BOOKS && tagOk(key, label))
    .sort((a, b) => b.stat.weight * corpus.idf(b.key) - a.stat.weight * corpus.idf(a.key));
  for (const { stat, label } of tagsLiked) {
    if (liked.filter((item) => item.kind === 'tag').length >= TASTE_LIKED_TAGS) break;
    const clean = cleanLabel(label);
    if (clean) liked.push({ kind: 'tag', label: clean, bookIds: ids(stat.holders, true) });
  }

  const against: { value: number; item: TasteItem }[] = [];
  for (const [key, stat] of profile.authors) {
    if (stat.weight >= 0 || stat.holders.filter((item) => item.like < 0).length < TASTE_MIN_BOOKS) continue;
    against.push({
      value: stat.weight,
      item: { kind: 'author', label: labelOf(stat, (item) => item.features.authors, key), bookIds: ids(stat.holders, false) },
    });
  }
  for (const [key, stat] of profile.tags) {
    const label = labelOf(stat, (item) => item.features.tags, key);
    if (stat.weight >= 0 || stat.holders.filter((item) => item.like < 0).length < TASTE_MIN_BOOKS || !tagOk(key, label)) continue;
    const clean = cleanLabel(label);
    if (!clean) continue;
    against.push({ value: stat.weight * corpus.idf(key), item: { kind: 'tag', label: clean, bookIds: ids(stat.holders, false) } });
  }
  const disliked = against
    .sort((a, b) => a.value - b.value)
    .slice(0, TASTE_DISLIKED)
    .map((entry) => entry.item);

  // La fascia di lunghezza con piu' abbandoni rispetto alla media.
  let worst: { band: number; rate: number } | null = null;
  for (const [band, [done, dropped]] of profile.bands) {
    if (done + dropped < TASTE_BAND_MIN_BOOKS) continue;
    const rate = dropped / (done + dropped);
    if (rate < profile.baseAbandonRate + TASTE_BAND_MIN_EXCESS) continue;
    if (!worst || rate > worst.rate) worst = { band, rate };
  }
  if (worst) {
    const dropped = signalBooks
      .filter((book) => book.readingStatus === 'dnf' && corpus.features.get(book.id)?.band === worst!.band)
      .slice(0, TASTE_BOOK_IDS)
      .map((book) => book.id);
    disliked.push({ kind: 'length', label: bandLabel(worst.band), bookIds: dropped });
  }
  return { liked, disliked };
}

/* ------------------------------------------------------------ risultato -- */

export interface RecommendationOptions {
  limit?: number;
}

/** Suggerimenti per i libri indicati (gia' filtrati con `visibleBooks`). */
export function computeRecommendations(
  books: BookMeta[],
  options: RecommendationOptions = {},
): RecommendationsResult {
  const limit = Math.max(1, Math.min(MAX_RECOMMENDATION_LIMIT, options.limit ?? DEFAULT_RECOMMENDATION_LIMIT));
  const signalBooks = books.filter((book) => {
    const like = likeSignal(book);
    return like !== null && like !== 0;
  });
  const basedOn = {
    read: books.filter(isRead).length,
    rated: books.filter((book) => book.rating !== null && book.rating !== undefined).length,
    abandoned: books.filter((book) => book.readingStatus === 'dnf').length,
    favorites: books.filter((book) => book.favorite).length,
  };
  // Un libro nascosto e poi letto non resta fra i nascosti.
  const dismissed = books
    .filter((book) => book.recommendationDismissed && book.readingStatus === 'unread')
    .map((book) => book.id);
  if (signalBooks.length < MIN_SIGNAL_BOOKS) {
    return { enough: false, taste: { liked: [], disliked: [] }, seriesNext: [], booksByAuthor: [], booksToExplore: [], fanfics: [], dismissed, basedOn };
  }

  const isCandidate = (book: BookMeta) =>
    book.readingStatus === 'unread' && !book.readingProgress && !book.recommendationDismissed;

  const bySeries = groupBySeries(books);

  const seriesNext = seriesNextPicks(bySeries, isCandidate);
  const taken = new Set(seriesNext.map((entry) => entry.id));

  // Per serie: solo il volume non letto con l'indice minore, e solo se la serie non e' iniziata
  // (quelle iniziate passano da «Continua una serie»).
  const eligible = (book: BookMeta): boolean => {
    const key = seriesKey(book);
    if (!key) return true;
    if ((bySeries.get(key) ?? []).some(isRead)) return false;
    return isLowestUnreadVolume(book, bySeries);
  };

  const candidates = books.filter((book) => isCandidate(book) && !taken.has(book.id) && eligible(book));
  const corpus = buildCorpus(books);
  const scored = scoreCandidates(corpus, signalBooks, candidates)
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.book.title.localeCompare(b.book.title))
    .map((entry) => ({ entry, built: buildReasons(entry) }));

  // Ogni sezione ha il suo ordine: i punteggi di libri e fanfic non si confrontano mai.
  const pick = (
    list: typeof scored,
    caps: { fandom?: boolean },
  ): BookRecommendation[] => {
    const picked: BookRecommendation[] = [];
    const perAuthor = new Map<string, number>();
    const perFandom = new Map<string, number>();
    const perShip = new Map<string, number>();
    const perSeries = new Set<string>();
    for (const { entry, built } of list) {
      if (picked.length >= limit) break;
      const book = entry.book;
      const author = firstAuthor(book);
      const series = seriesKey(book);
      const fandom = norm(book.fandom ?? '');
      const ship = norm((book.ships ?? [])[0] ?? (book.relationships ?? [])[0] ?? '');
      if (author && (perAuthor.get(author) ?? 0) >= MAX_PER_AUTHOR) continue;
      if (series && perSeries.has(series)) continue;
      if (caps.fandom && fandom && (perFandom.get(fandom) ?? 0) >= MAX_PER_FANDOM) continue;
      if (caps.fandom && ship && (perShip.get(ship) ?? 0) >= MAX_PER_SHIP) continue;
      if (author) perAuthor.set(author, (perAuthor.get(author) ?? 0) + 1);
      if (series) perSeries.add(series);
      if (caps.fandom && fandom) perFandom.set(fandom, (perFandom.get(fandom) ?? 0) + 1);
      if (caps.fandom && ship) perShip.set(ship, (perShip.get(ship) ?? 0) + 1);
      picked.push({ id: book.id, score: entry.score, reasons: built.reasons });
    }
    return picked;
  };

  const ofBooks = scored.filter(({ entry, built }) => entry.book.kind === 'book' && built.specific);
  const booksByAuthor = pick(ofBooks.filter(({ built }) => built.author), {});
  const booksToExplore = pick(ofBooks.filter(({ built }) => !built.author), {});
  const fanfics = pick(scored.filter(({ entry, built }) => entry.book.kind === 'fanfic' && built.specific), { fandom: true });

  return {
    enough: true,
    taste: computeTaste(corpus, signalBooks),
    seriesNext: seriesNext.slice(0, limit),
    booksByAuthor,
    booksToExplore,
    fanfics,
    dismissed,
    basedOn,
  };
}
