/**
 * Parser dei metadati inline tipici delle fanfiction.
 *
 * Molti epub di fanfic contengono una pagina "Info" con coppie
 * `Etichetta: valore` (stile AO3, FanFiction.net, o dump di archivi).
 * Nei download EPUB di AO3 le etichette e i valori sono spesso su righe
 * separate (`Rating:` / `Explicit`), quindi gestiamo entrambe le forme.
 */

export type FanficKey =
  | 'title'
  | 'author'
  | 'fandom'
  | 'characters'
  | 'relationships'
  | 'rating'
  | 'warnings'
  | 'language'
  | 'words'
  | 'chapters'
  | 'status'
  | 'published'
  | 'updated'
  | 'completed'
  | 'summary'
  | 'series'
  | 'beta'
  | 'tags'
  | 'tolls';

const LABELS: Record<string, FanficKey> = {
  title: 'title',
  titolo: 'title',
  work: 'title',
  story: 'title',

  author: 'author',
  authors: 'author',
  by: 'author',
  autore: 'author',
  autrice: 'author',
  written: 'author',
  writer: 'author',
  'written by': 'author',

  fandom: 'fandom',
  fandoms: 'fandom',
  'fandom(s)': 'fandom',
  universe: 'fandom',

  characters: 'characters',
  character: 'characters',
  cast: 'characters',
  personaggi: 'characters',

  relationships: 'relationships',
  relationship: 'relationships',
  pairings: 'relationships',
  pairing: 'relationships',
  'pairing(s)': 'relationships',
  ship: 'relationships',
  ships: 'relationships',
  'ship(s)': 'relationships',

  rating: 'rating',
  'maturity rating': 'rating',
  'content rating': 'rating',
  'content warnings': 'warnings',
  warnings: 'warnings',
  warning: 'warnings',
  'archive warning': 'warnings',
  'archive warnings': 'warnings',

  category: 'tags',
  categories: 'tags',

  language: 'language',
  lingua: 'language',

  words: 'words',
  'word count': 'words',
  'total words': 'words',
  lunghezza: 'words',

  chapters: 'chapters',
  'chapter count': 'chapters',
  capitoli: 'chapters',

  status: 'status',
  'series status': 'status',
  stato: 'status',

  published: 'published',
  'published on': 'published',
  date: 'published',

  updated: 'updated',
  'updated on': 'updated',
  'last updated': 'updated',

  completed: 'completed',
  'completed on': 'completed',

  summary: 'summary',
  synopsis: 'summary',
  descrizione: 'summary',
  abstract: 'summary',

  series: 'series',
  'part of': 'series',
  serie: 'series',

  beta: 'beta',
  'beta readers': 'beta',

  'additional tags': 'tags',
  tags: 'tags',
  genres: 'tags',
  genre: 'tags',

  stats: 'tolls',
  tolls: 'tolls',
};

export interface FanficMeta {
  detected: boolean;
  score: number;
  title: string;
  author: string;
  fandom: string;
  characters: string[];
  relationships: string[];
  rating: string;
  warnings: string[];
  language: string;
  words: number | null;
  chapters: number | null;
  status: string;
  published: string;
  updated: string;
  summary: string;
  series: string;
  seriesIndex: number | null;
  ao3Url: string;
  ffnetUrl: string;
  tags: string[];
}

const RATING_MAP: Array<[RegExp, string]> = [
  [/general audiences/i, 'G'],
  [/general/i, 'G'],
  [/teen and up/i, 'PG-13'],
  [/pg-?13/i, 'PG-13'],
  [/mature/i, 'M'],
  [/explicit/i, 'MA'],
  [/not rated/i, 'NR'],
  [/\bma\b/i, 'MA'],
  [/\bk\+/i, 'PG'],
  [/\bk\b/i, 'G'],
  [/\bt\b/i, 'PG-13'],
  [/\bm\b/i, 'M'],
];

const STATUS_MAP: Array<[RegExp, string]> = [
  [/work in progress|\bwip\b|ongoing/i, 'Incomplete'],
  [/incomplete/i, 'Incomplete'],
  [/complete/i, 'Complete'],
];

const LANGUAGE_MAP: Record<string, string> = {
  english: 'en',
  inglese: 'en',
  italian: 'it',
  italiano: 'it',
  french: 'fr',
  francese: 'fr',
  spanish: 'es',
  spagnolo: 'es',
  espanol: 'es',
  espaol: 'es',
  german: 'de',
  tedesco: 'de',
  deutsch: 'de',
  portuguese: 'pt',
  portoghese: 'pt',
  portugues: 'pt',
  portugus: 'pt',
  francais: 'fr',
  franais: 'fr',
  russian: 'ru',
  russo: 'ru',
  japanese: 'ja',
  giapponese: 'ja',
  chinese: 'zh',
  cinese: 'zh',
};

const LABEL_PATTERN = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ()\/'*.\-]{1,42}?)\s*[:：]\s*(.*)$/;
const SECTION_HEADING = /^(?:summary|notes?|author'?s notes?|end notes?|chapter text|chapter\s+\d+|afterword|foreword|prologue|epilogue)$/i;
const LIST_KEYS: FanficKey[] = ['characters', 'relationships', 'warnings', 'tags'];

function splitList(value: string): string[] {
  // AO3 separa le liste con virgole; non spezziamo su "and"/"or" o su "|"
  // perche' fanno parte di molti tag (es. "Dreams and Nightmares",
  // "Deutsch | German").
  return value
    .split(/\s*[,;]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1 && part.length < 120);
}

function normalizeRating(value: string): string {
  for (const [pattern, code] of RATING_MAP) {
    if (pattern.test(value)) return code;
  }
  return value.trim().slice(0, 12);
}

function normalizeStatus(value: string): string {
  for (const [pattern, code] of STATUS_MAP) {
    if (pattern.test(value)) return code;
  }
  return value.trim().slice(0, 24);
}

function normalizeLanguage(value: string): string {
  const clean = value.trim();
  const key = clean.toLowerCase().replace(/[^a-z]/g, '');
  if (LANGUAGE_MAP[key]) return LANGUAGE_MAP[key];
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(clean)) return clean.toLowerCase().slice(0, 2);
  return clean.slice(0, 60);
}

function parseWordCount(value: string): number | null {
  const match = value.match(/\d[\d.,\s]*/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  if (!digits) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

interface ChapterCount {
  current: number | null;
  total: number | null;
  openEnded: boolean;
}

function parseChapterCount(value: string): ChapterCount {
  const fraction = value.match(/(\d+)\s*\/\s*(\d+|\?)/);
  if (fraction) {
    const current = Number.parseInt(fraction[1], 10);
    const total = fraction[2] === '?' ? null : Number.parseInt(fraction[2], 10);
    return {
      current: Number.isFinite(current) ? current : null,
      total: Number.isFinite(total as number) ? total : null,
      openEnded: fraction[2] === '?',
    };
  }
  const single = value.match(/\d+/);
  const current = single ? Number.parseInt(single[0], 10) : null;
  return {
    current: Number.isFinite(current as number) ? current : null,
    total: null,
    openEnded: false,
  };
}

function parseSeriesValue(value: string): { name: string; index: number | null } {
  const clean = value
    .replace(/\s+/g, ' ')
    .replace(/\s*Next Work\s*→?\s*$/i, '')
    .trim();
  const match = clean.match(/^Part\s+(\d+)\s+of[,\s]+(.+)$/i);
  if (match) {
    const index = Number.parseInt(match[1], 10);
    return {
      name: match[2].trim().slice(0, 200),
      index: Number.isFinite(index) ? index : null,
    };
  }
  return { name: clean.slice(0, 200), index: null };
}

function canonicalAo3Url(url: string): string {
  const match = url.match(/archiveofourown\.org\/works\/(\d+)/i);
  return match ? `https://archiveofourown.org/works/${match[1]}` : url;
}

function canonicalFfnetUrl(url: string): string {
  const match = url.match(/fanfiction\.net\/s\/(\d+)/i);
  return match ? `https://www.fanfiction.net/s/${match[1]}` : url;
}

function extractSummarySection(lines: string[]): string {
  const start = lines.findIndex((line) => /^summary[:\s]*$/i.test(line.trim()));
  if (start < 0) return '';
  const collected: string[] = [];
  for (let i = start + 1; i < lines.length && i < start + 120; i += 1) {
    const line = lines[i].replace(/\u00a0/g, ' ').trim();
    if (!line) {
      if (collected.length) collected.push('');
      continue;
    }
    if (SECTION_HEADING.test(line)) break;
    if (
      /^(?:rating|archive warnings?|category|categories|fandom|fandoms|relationship|relationships|character|characters|additional tags|tags|language|series|stats|published|completed|updated|words|chapters|status):/i.test(
        line,
      )
    ) {
      break;
    }
    collected.push(line);
    if (collected.join(' ').length > 4000) break;
  }
  return collected.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

/**
 * Cerca coppie "Etichetta: valore" nel testo e le classifica.
 * Gestisce sia il formato su una riga sia quello con il valore sulla riga
 * successiva, tipico delle pagine Info degli EPUB AO3.
 */
export function parseFanficMetadata(text: string): FanficMeta {
  const result: FanficMeta = {
    detected: false,
    score: 0,
    title: '',
    author: '',
    fandom: '',
    characters: [],
    relationships: [],
    rating: '',
    warnings: [],
    language: '',
    words: null,
    chapters: null,
    status: '',
    published: '',
    updated: '',
    summary: '',
    series: '',
    seriesIndex: null,
    ao3Url: '',
    ffnetUrl: '',
    tags: [],
  };
  if (!text) return result;

  const found = new Map<FanficKey, string[]>();
  const push = (key: FanficKey, value: string) => {
    const list = found.get(key) ?? [];
    list.push(value);
    found.set(key, list);
  };

  const lines = text.split(/\r?\n/).slice(0, 500);
  let pending: { key: FanficKey; values: string[]; maxLines: number } | null = null;
  let consecutive = 0;
  let bestBlock = 0;

  const joinValues = (key: FanficKey, values: string[]): string => {
    if (key === 'summary') return values.join('\n');
    if (key === 'fandom') return values.join(', ');
    if (key === 'series') return values.join(' ');
    if (LIST_KEYS.includes(key)) return values.join(', ');
    return values.join(' ');
  };

  const finishPending = () => {
    if (!pending) return;
    if (pending.values.length) {
      push(pending.key, joinValues(pending.key, pending.values));
    }
    pending = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) continue;

    const lineLimit = pending ? 6000 : 400;
    if (line.length > lineLimit) {
      finishPending();
      consecutive = 0;
      continue;
    }

    const match = line.match(LABEL_PATTERN);
    const label = match ? match[1].trim().toLowerCase().replace(/\*+$/, '').trim() : '';
    const key = match ? LABELS[label] : undefined;
    const value = match ? match[2].trim() : '';

    if (pending) {
      const isHeading = SECTION_HEADING.test(line);

      if (isHeading) {
        finishPending();
        consecutive = 0;
        continue;
      }
      // Chiudiamo il valore solo su un'etichetta *riconosciuta*. Cosi' non
      // perdiamo i tag che contengono i due punti (es. "Alternate Universe:
      // Canon Divergence") ne' le righe di dialogo nel summary.
      if (key !== undefined) {
        finishPending();
        // La riga corrente viene gestita come nuova etichetta qui sotto.
      } else {
        if (pending.values.length < pending.maxLines) pending.values.push(line);
        if (pending.values.length >= pending.maxLines) finishPending();
        continue;
      }
    }

    if (!match) {
      consecutive = 0;
      continue;
    }

    if (!key) {
      consecutive = 0;
      continue;
    }

    if (value) {
      push(key, value);
      consecutive += 1;
      if (consecutive > bestBlock) bestBlock = consecutive;
    } else {
      consecutive = 0;
      pending = {
        key,
        values: [],
        maxLines:
          key === 'summary'
            ? 40
            : LIST_KEYS.includes(key)
              ? 12
              : 3,
      };
    }
  }
  finishPending();

  const value = (key: FanficKey): string => found.get(key)?.[0] ?? '';

  if (value('title')) result.title = value('title').slice(0, 300);
  if (value('author')) result.author = value('author').slice(0, 200);
  if (value('fandom')) {
    result.fandom = value('fandom')
      .replace(/\s+,/g, ',')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
  }
  if (found.has('characters')) result.characters = splitList(value('characters'));
  if (found.has('relationships')) result.relationships = splitList(value('relationships'));
  if (value('rating')) result.rating = normalizeRating(value('rating'));
  if (found.has('warnings')) result.warnings = splitList(value('warnings'));
  if (value('language')) result.language = normalizeLanguage(value('language'));
  if (found.has('words')) result.words = parseWordCount(value('words'));

  const chapters = parseChapterCount(value('chapters'));
  if (chapters.current !== null) result.chapters = chapters.current;

  if (value('status')) result.status = normalizeStatus(value('status'));
  else if (value('completed')) result.status = 'Complete';
  else if (value('updated')) result.status = 'Incomplete';
  else if (
    chapters.openEnded ||
    (chapters.current !== null && chapters.total !== null && chapters.total > chapters.current)
  ) {
    result.status = 'Incomplete';
  } else if (
    chapters.current !== null &&
    chapters.total !== null &&
    chapters.current === chapters.total
  ) {
    result.status = 'Complete';
  }

  if (value('published')) result.published = value('published').slice(0, 60);
  if (value('updated')) result.updated = value('updated').slice(0, 60);
  const cleanSummary = (summary: string) =>
    summary
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  if (value('summary')) result.summary = cleanSummary(value('summary')).slice(0, 4000);
  else result.summary = cleanSummary(extractSummarySection(lines));

  if (value('series')) {
    const series = parseSeriesValue(value('series'));
    result.series = series.name;
    result.seriesIndex = series.index;
  }

  for (const raw of found.get('tags') ?? []) {
    result.tags.push(...splitList(raw));
  }
  result.tags = [...new Set(result.tags)];

  // Fallback per titolo e autore: "Titolo" seguito da "by Autore".
  if (!result.title || !result.author) {
    const byIndex = lines.findIndex((line) => /^by\s+\S+/i.test(line.trim()));
    if (byIndex > 0 && byIndex < 80) {
      const byLine = lines[byIndex].trim().replace(/^by\s+/i, '').trim();
      if (!result.author && byLine) result.author = byLine.slice(0, 200);
      if (!result.title) {
        const previous = lines
          .slice(0, byIndex)
          .reverse()
          .map((line) => line.trim())
          .find(
            (line) =>
              Boolean(line) &&
              !LABEL_PATTERN.test(line) &&
              !/^https?:\/\//i.test(line) &&
              !SECTION_HEADING.test(line),
          );
        if (previous && previous.length <= 200) result.title = previous;
      }
    }
  }

  /* URL */
  const urls = text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [];
  for (const url of urls) {
    const clean = url.replace(/[.,;:]$/, '');
    if (/archiveofourown\.org/i.test(clean) && !result.ao3Url) {
      result.ao3Url = canonicalAo3Url(clean);
    } else if (/fanfiction\.net/i.test(clean) && !result.ffnetUrl) {
      result.ffnetUrl = canonicalFfnetUrl(clean);
    }
  }

  result.detected = found.size >= 3 || bestBlock >= 3;
  result.score = found.size;
  return result;
}

/** Riconosce i segni tipici di una fanfiction in un testo libero. */
export function looksLikeFanfic(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const markers = [
    'fandom:',
    'fandoms:',
    'relationship:',
    'relationships:',
    'characters:',
    'rating:',
    'archive warning',
    'pairing:',
    'ship:',
    'ao3',
    'archive of our own',
    'fanfiction.net',
    'additional tags',
  ];
  const hits = markers.filter((marker) => lower.includes(marker)).length;
  return hits >= 2;
}

/** Estrae "Serie - Numero" dal titolo, es. "Hogwarts Mystery #3 - ...". */
export function parseSeriesFromTitle(title: string): { series: string; index: number | null } {
  const match = title.match(/^(.+?)\s*(?:#|n[.°º]|vol\.?|volume|libro|book)\s*(\d+(?:[.,]\d+)?)\b\s*[-:–—]?\s*(.*)$/i);
  if (match) {
    const index = Number.parseFloat(match[2].replace(',', '.'));
    return {
      series: match[1].trim().replace(/[#–—:-]+$/, '').trim(),
      index: Number.isFinite(index) ? index : null,
    };
  }
  const tilde = title.match(/^(.+?)\s*[-–—]\s*(?:libro\s*)?(\d+)\s+(?:di|of)\s+(\d+)\b/i);
  if (tilde) {
    const index = Number.parseInt(tilde[2], 10);
    return { series: tilde[1].trim(), index: Number.isFinite(index) ? index : null };
  }
  return { series: '', index: null };
}
