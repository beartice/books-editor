import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeFetch } from './net.js';
import { parseEpub } from './metadata/epub.js';
import { parseDocx, parsePdf, parsePlain } from './metadata/other.js';
import type { GenericInfo } from './metadata/other.js';
import {
  looksLikeFanfic,
  parseFanficMetadata,
  parseSeriesFromTitle,
} from './metadata/fanfic.js';
import { loadIndex, loadSettings, saveIndex, toSummary } from './store.js';
import { htmlToText } from './htmlText.js';
import { detectLanguage, toIso6391 } from './language.js';
import { normalizeTags } from './tags.js';
import { lookupOnline, pickBestCandidate } from './providers/index.js';
import type { BookEdition, BookMeta, BookSummary, MetadataCandidate, ScanResult } from '../../shared/types.js';

export const MEDIA_EXTENSIONS = new Set(['.epub', '.pdf', '.docx', '.txt', '.md', '.rtf']);
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

export const BOOK_JSON = 'book.json';

export type Format = BookMeta['format'];

export function detectFormat(filePath: string): Format {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt') return 'txt';
  if (ext === '.md') return 'md';
  if (ext === '.rtf') return 'rtf';
  return 'other';
}

export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'senza-titolo';
}

export function emptyMeta(): BookMeta {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: 'book',
    folder: '',
    sourceFile: null,
    format: 'other',
    extraFiles: [],
    coverFile: null,
    title: '',
    subtitle: '',
    authors: [],
    series: '',
    seriesIndex: null,
    highlights: [],
    publisher: '',
    publishedDate: '',
    language: '',
    isbn: '',
    identifiers: {},
    description: '',
    pageCount: null,
    wordCount: null,
    charCount: null,
    fandom: '',
    ships: [],
    characters: [],
    relationships: [],
    fanRating: '',
    tags: [],
    status: '',
    chapters: null,
    ao3Url: '',
    ffnetUrl: '',
    efpUrl: '',
    notes: '',
    rating: null,
    favorite: false,
    readingStatus: 'unread',
    readingProgress: null,
    dateFinished: null,
    dateAdded: now,
    dateModified: now,
    lastRead: null,
    fieldSource: {},
  };
}

export interface ExtractedInfo {
  title: string;
  subtitle: string;
  authors: string[];
  publisher: string;
  publishedDate: string;
  language: string;
  isbn: string;
  identifiers: Record<string, string>;
  description: string;
  subjects: string[];
  series: string;
  seriesIndex: number | null;
  pageCount: number | null;
  wordCount: number;
  charCount: number;
  chapters: number | null;
  cover: { data: Buffer; ext: string } | null;
  headText: string;
  infoText: string;
}

/** Estrae i metadati da un file, scegliendo il parser in base al formato. */
export async function extractInfo(filePath: string): Promise<ExtractedInfo> {
  const format = detectFormat(filePath);
  if (format === 'epub') {
    const info = await parseEpub(filePath);
    return {
      ...info,
      pageCount: null,
      chapters: info.chapters,
    };
  }
  if (format === 'pdf') {
    const info = await parsePdf(filePath);
    return { ...info, series: '', seriesIndex: null, chapters: null };
  }
  if (format === 'docx') {
    const info = await parseDocx(filePath);
    return { ...info, series: '', seriesIndex: null, chapters: null };
  }
  const info = await parsePlain(filePath);
  return { ...info, series: '', seriesIndex: null, chapters: null };
}

/** Riconosce i link AO3/FanFiction.net salvati negli identificatori OPF. */
function fanficUrlsFromIdentifiers(
  identifiers: Record<string, string>,
): { ao3Url: string; ffnetUrl: string } {
  let ao3Url = '';
  let ffnetUrl = '';
  for (const value of Object.values(identifiers)) {
    if (!value) continue;
    const ao3 = value.match(/archiveofourown\.org\/works\/(\d+)/i);
    if (ao3) ao3Url = ao3Url || `https://archiveofourown.org/works/${ao3[1]}`;
    const ffnet = value.match(/fanfiction\.net\/s\/(\d+)/i);
    if (ffnet) ffnetUrl = ffnetUrl || `https://www.fanfiction.net/s/${ffnet[1]}`;
  }
  return { ao3Url, ffnetUrl };
}

/** Costruisce i metadati di un libro a partire dall'estrazione. */
export function buildMetaFromInfo(
  info: ExtractedInfo,
  fileName: string,
): Partial<BookMeta> {
  const baseTitle = info.title || path.basename(fileName, path.extname(fileName));
  const { series: seriesFromTitle, index: indexFromTitle } = parseSeriesFromTitle(baseTitle);

  // `infoText` e' spesso gia' incluso in `headText`: evitiamo di analizzare
  // due volte la stessa pagina informativa.
  const combinedText =
    info.infoText && !info.headText.includes(info.infoText.slice(0, 200))
      ? `${info.infoText}\n${info.headText}`
      : info.headText;
  const fanfic = parseFanficMetadata(combinedText);
  const identifierUrls = fanficUrlsFromIdentifiers(info.identifiers);
  const subjectsText = info.subjects.join(' ').toLowerCase();
  const isFanfic =
    fanfic.detected ||
    looksLikeFanfic(combinedText) ||
    /fandom|ao3|fanfiction/.test(subjectsText) ||
    Boolean(fanfic.ao3Url || fanfic.ffnetUrl) ||
    Boolean(identifierUrls.ao3Url || identifierUrls.ffnetUrl);

  const fields: Partial<BookMeta> = {
    title: baseTitle,
    subtitle: info.subtitle,
    authors: info.authors,
    publisher: info.publisher,
    publishedDate: info.publishedDate,
    language: info.language,
    isbn: info.isbn,
    identifiers: info.identifiers,
    // Le descrizioni degli EPUB (Calibre, editori) sono spesso HTML.
    description: htmlToText(info.description),
    pageCount: info.pageCount,
    wordCount: info.wordCount,
    charCount: info.charCount,
    chapters: info.chapters,
    series: info.series || seriesFromTitle,
    seriesIndex: info.seriesIndex ?? indexFromTitle,
    kind: isFanfic ? 'fanfic' : 'book',
  };

  if (isFanfic) {
    const ao3Url = fanfic.ao3Url || identifierUrls.ao3Url;
    const ffnetUrl = fanfic.ffnetUrl || identifierUrls.ffnetUrl;
    Object.assign(fields, {
      fandom: fanfic.fandom || (info.subjects[0] ?? ''),
      characters: fanfic.characters,
      relationships: fanfic.relationships,
      ships: fanfic.relationships,
      fanRating: fanfic.rating,
      status: fanfic.status,
      tags: normalizeTags([
        ...fanfic.tags,
        ...fanfic.warnings,
        ...info.subjects,
      ]).slice(0, 60),
    });
    if (ao3Url) fields.ao3Url = ao3Url;
    if (ffnetUrl) fields.ffnetUrl = ffnetUrl;
    if (!fields.description && fanfic.summary) fields.description = htmlToText(fanfic.summary);
    if (!fields.authors?.length && fanfic.author) fields.authors = [fanfic.author];
    if (!fields.title && fanfic.title) fields.title = fanfic.title;
    if (!fields.publishedDate && fanfic.published) fields.publishedDate = fanfic.published;
    if (!fields.language && fanfic.language) fields.language = fanfic.language;
    if (!fields.series && fanfic.series) {
      fields.series = fanfic.series;
      fields.seriesIndex = fanfic.seriesIndex;
    } else if (fields.seriesIndex == null && fanfic.seriesIndex !== null) {
      fields.seriesIndex = fanfic.seriesIndex;
    }
    // Per le fanfic i conteggi dichiarati dall'autrice sono la fonte
    // canonica: il conteggio parole ricavato dai file include preface, note e
    // afterword, e il numero di file dello spine non coincide con i capitoli.
    if (fanfic.words) fields.wordCount = fanfic.words;
    if (fanfic.chapters) fields.chapters = fanfic.chapters;
  } else if (info.subjects.length) {
    fields.tags = normalizeTags(info.subjects).slice(0, 30);
  }

  return fields;
}

/* --------------------------------------------------------------- libreria -- */

export interface BookRecord {
  meta: BookMeta;
  /** Percorso assoluto del file sorgente. */
  sourcePath: string | null;
  /** Percorso assoluto della copertina. */
  coverPath: string | null;
}

export async function getBookRecord(id: string): Promise<BookRecord | null> {
  const index = await loadIndex();
  const meta = index.find((b) => b.id === id);
  if (!meta) return null;
  const settings = await loadSettings();
  const folderPath = path.join(settings.libraryRoot, meta.folder);
  return {
    meta,
    sourcePath: meta.sourceFile ? path.join(folderPath, meta.sourceFile) : null,
    coverPath: meta.coverFile ? path.join(folderPath, meta.coverFile) : null,
  };
}

export async function getBookMeta(id: string): Promise<BookMeta | null> {
  const index = await loadIndex();
  return index.find((b) => b.id === id) ?? null;
}

async function readBookJson(folderPath: string): Promise<BookMeta | null> {
  try {
    const raw = await fsp.readFile(path.join(folderPath, BOOK_JSON), 'utf8');
    return { ...emptyMeta(), ...(JSON.parse(raw) as BookMeta) };
  } catch {
    return null;
  }
}

export async function writeBookJsonPublic(folderPath: string, meta: BookMeta): Promise<void> {
  return writeBookJson(folderPath, meta);
}

async function writeBookJson(folderPath: string, meta: BookMeta): Promise<void> {
  await fsp.mkdir(folderPath, { recursive: true });
  const file = path.join(folderPath, BOOK_JSON);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function listMediaFiles(folderPath: string): Promise<string[]> {
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();
}

async function findCoverFile(folderPath: string): Promise<string | null> {
  const entries = await fsp.readdir(folderPath, { withFileTypes: true });
  const images = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
  const named = images.find((name) => /^cover\./i.test(name));
  return named ?? images[0] ?? null;
}

/**
 * Scansiona la libreria: importa le cartelle nuove, aggiorna quelle esistenti
 * e rimuove dall'indice i record il cui file e' sparito.
 */
export async function scanLibrary(): Promise<ScanResult> {
  const settings = await loadSettings();
  const root = settings.libraryRoot;
  await fsp.mkdir(root, { recursive: true });

  const index = await loadIndex();
  const byFolder = new Map(index.map((book) => [book.folder, book]));

  const result: ScanResult = { added: 0, updated: 0, removed: 0, errors: [], scannedFolders: 0 };
  const next: BookMeta[] = [];

  const entries = await fsp.readdir(root, { withFileTypes: true });

  // 1) Cartelle: sono la fonte di verita' (una cartella = un'opera).
  const folders = entries.filter((entry) => entry.isDirectory());
  for (const folder of folders) {
    const folderName = folder.name;
    if (folderName.startsWith('.')) continue;
    const folderPath = path.join(root, folderName);
    result.scannedFolders += 1;

    try {
      const mediaFiles = await listMediaFiles(folderPath);
      const existingMeta = await readBookJson(folderPath);

      if (!mediaFiles.length && !existingMeta) continue;

      let meta: BookMeta;
      if (!existingMeta) {
        const sourceName = mediaFiles[0];
        const info = await extractInfo(path.join(folderPath, sourceName));
        const built = buildMetaFromInfo(info, sourceName);
        meta = emptyMeta();
        Object.assign(meta, built);
        meta.folder = folderName;
        meta.sourceFile = sourceName;
        meta.format = detectFormat(sourceName);
        meta.extraFiles = mediaFiles.slice(1);
        meta.fieldSource = Object.fromEntries(
          Object.keys(built).map((key) => [key, 'file']),
        );
        const cover = await findCoverFile(folderPath);
        meta.coverFile = cover;
        await writeBookJson(folderPath, meta);
        result.added += 1;
        if (settings.autoLookup) {
          const filled = await autoFillFromOnline(meta);
          meta = filled;
        }
      } else {
        const known = byFolder.get(folderName);
        meta = { ...existingMeta };
        meta.id = known?.id ?? meta.id;
        meta.dateAdded = known?.dateAdded ?? meta.dateAdded;
        // Il file sorgente potrebbe essere stato rinominato.
        if (!meta.sourceFile || !mediaFiles.includes(meta.sourceFile)) {
          meta.sourceFile = mediaFiles[0] ?? null;
        }
        meta.extraFiles = mediaFiles.filter((f) => f !== meta.sourceFile);
        // Le edizioni il cui file non esiste piu' (o e' diventato il principale) cadono.
        if (meta.editions) {
          meta.editions = meta.editions.filter(
            (edition) => edition.file !== meta.sourceFile && mediaFiles.includes(edition.file),
          );
        }
        meta.format = meta.sourceFile ? detectFormat(meta.sourceFile) : meta.format;
        const cover = await findCoverFile(folderPath);
        if (cover !== meta.coverFile) meta.coverFile = cover;
        // Schede importate prima delle pulizie automatiche: ripulisce l'HTML
        // nella descrizione e i tag composti, senza cambiarne la provenienza.
        const description = htmlToText(meta.description);
        const tags = normalizeTags(meta.tags);
        if (
          description !== meta.description ||
          JSON.stringify(tags) !== JSON.stringify(meta.tags)
        ) {
          meta.description = description;
          meta.tags = tags;
          await writeBookJson(folderPath, meta);
        }
        const changed = known
          ? JSON.stringify(stripVolatile(known)) !== JSON.stringify(stripVolatile(meta))
          : false;
        meta.dateModified = changed
          ? new Date().toISOString()
          : known?.dateModified ?? meta.dateModified;
        if (changed) result.updated += 1;
      }

      next.push(meta);
    } catch (error) {
      result.errors.push(`${folderName}: ${(error as Error).message}`);
    }
  }

  // 2) File sciolti nella radice: vengono importati nella cartella dedicata.
  //    Skippiamo quelli gia' presenti dentro una cartella, per non duplicarli.
  const claimed = new Set<string>();
  for (const book of next) {
    if (book.sourceFile) claimed.add(book.sourceFile.toLowerCase());
    for (const extra of book.extraFiles) claimed.add(extra.toLowerCase());
  }

  const looseFiles = entries
    .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);

  for (const fileName of looseFiles) {
    if (claimed.has(fileName.toLowerCase())) continue;
    try {
      const imported = await importFile(path.join(root, fileName));
      next.push(imported);
      result.added += 1;
    } catch (error) {
      result.errors.push(`${fileName}: ${(error as Error).message}`);
    }
  }

  // 3) Record rimossi dal disco.
  const foldersNow = new Set(next.map((book) => book.folder));
  for (const book of index) {
    if (!foldersNow.has(book.folder)) {
      result.removed += 1;
    }
  }

  await saveIndex(next);
  return result;
}

function stripVolatile(meta: BookMeta): Omit<BookMeta, 'dateModified'> {
  const { dateModified, ...rest } = meta;
  return rest;
}

/**
 * Importa un singolo file (o cartella) nella libreria.
 * Se il file e' gia' dentro la libreria, viene importato cosi' com'e'.
 */
export async function importPath(target: string): Promise<BookMeta> {
  const settings = await loadSettings();
  const absolute = path.resolve(target);
  const stats = await fsp.stat(absolute);
  if (stats.isDirectory()) {
    const media = await listMediaFiles(absolute);
    if (!media.length) throw new Error('Nessun file leggibile nella cartella');
    return importFile(path.join(absolute, media[0]), absolute);
  }
  return importFile(absolute);
}

export async function uniqueFolderName(root: string, base: string): Promise<string> {
  let candidate = sanitizeFolderName(base);
  let counter = 2;
  while (true) {
    const exists = await fsp
      .stat(path.join(root, candidate))
      .then(() => true)
      .catch(() => false);
    if (!exists) return candidate;
    const suffix = ` (${counter})`;
    candidate = sanitizeFolderName(`${base.slice(0, 120 - suffix.length)}${suffix}`);
    counter += 1;
  }
}

export interface DuplicateMatch {
  /** 'language' = stessa opera ma in un'altra lingua: si puo' aggiungere come edizione. */
  reason: 'file' | 'isbn' | 'title' | 'language';
  book: BookMeta;
  /** Solo per 'language': lingua del file e lingue gia' presenti nella scheda. */
  language?: string;
  existingLanguages?: string[];
}

/** Hash SHA-256 di un file, letto in streaming. */
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizeIsbn(value: string): string {
  return (value ?? '').replace(/[^0-9xX]/g, '').toUpperCase();
}

/**
 * Cerca nella libreria un'opera gia' presente, equivalente al file indicato
 * (o al primo file leggibile, se e' una cartella). Controlli in ordine:
 * stesso file (contenuto), stesso ISBN, stesso titolo e primo autore.
 */
export async function findDuplicate(target: string): Promise<DuplicateMatch | null> {
  let filePath = path.resolve(target);
  const targetStat = await fsp.stat(filePath);
  if (targetStat.isDirectory()) {
    const media = await listMediaFiles(filePath);
    if (!media.length) return null;
    filePath = path.join(filePath, media[0]);
  }
  const settings = await loadSettings();
  const root = settings.libraryRoot;
  const index = await loadIndex();
  const size = (await fsp.stat(filePath)).size;

  // 1) Stesso file: prima la dimensione, l'hash solo se coincide.
  let hash: string | null = null;
  for (const book of index) {
    for (const name of [book.sourceFile, ...(book.extraFiles ?? [])]) {
      if (!name) continue;
      const candidate = path.join(root, book.folder, name);
      try {
        const candidateStat = await fsp.stat(candidate);
        if (!candidateStat.isFile() || candidateStat.size !== size) continue;
        hash ??= await hashFile(filePath);
        if ((await hashFile(candidate)) === hash) return { reason: 'file', book };
      } catch {
        // File mancante o illeggibile: si passa oltre.
      }
    }
  }

  // 2) e 3) Metadati: se l'estrazione fallisce resta solo il controllo sul file.
  let built: Partial<BookMeta>;
  let info: ExtractedInfo;
  try {
    info = await extractInfo(filePath);
    built = buildMetaFromInfo(info, path.basename(filePath));
  } catch {
    return null;
  }

  const byMeta = await findDuplicateByMeta({
    title: built.title,
    authors: built.authors,
    isbn: built.isbn,
  });
  // Stessa edizione (ISBN): non e' un'altra lingua.
  if (byMeta?.reason === 'isbn') return byMeta;

  // Stessa opera in un'altra lingua: solo se la lingua del file e' nota e la
  // scheda non ha gia' un'edizione in quella lingua.
  const language = await fileLanguage(filePath, info);
  if (language) {
    const sameWork = findSameWork(
      {
        title: built.title ?? '',
        authors: built.authors ?? [],
        series: built.series ?? '',
        seriesIndex: built.seriesIndex ?? null,
      },
      index,
    );
    const known = sameWork.map((book) => ({ book, languages: bookLanguages(book) }));
    if (known.length && !known.some((entry) => entry.languages.includes(language))) {
      // La lingua della principale deve essere nota, altrimenti non si puo' dire che differisca.
      const found = known.find((entry) => toIso6391(entry.book.language ?? ''));
      if (found) {
        return {
          reason: 'language',
          book: found.book,
          language,
          existingLanguages: found.languages,
        };
      }
    }
  }
  return byMeta;
}

/** Lingue note di una scheda: la principale piu' quelle delle edizioni. */
export function bookLanguages(book: BookMeta): string[] {
  const languages = [toIso6391(book.language ?? ''), ...(book.editions ?? []).map((e) => e.language)];
  return [...new Set(languages.filter((code): code is string => Boolean(code)))];
}

/**
 * Lingua di un file: quella dichiarata (dc:language), a meno che il testo
 * dell'EPUB non indichi con margine netto un'altra lingua (alcuni EPUB
 * dichiarano la lingua sbagliata). '' se non si riesce a stabilirla.
 */
export async function fileLanguage(filePath: string, info?: ExtractedInfo): Promise<string> {
  const extracted = info ?? (await extractInfo(filePath));
  const declared = toIso6391(extracted.language ?? '') ?? '';
  const detected =
    detectFormat(filePath) === 'epub' ? detectLanguage(extracted.headText ?? '') : '';
  return detected || declared;
}

/**
 * Parte principale di un titolo: prima di ':', di '. ', di ' - ' o di ' (', senza
 * parentesi e senza l'eventuale numero di volume iniziale ("1. Nevernight - ...").
 */
/** Titolo senza numero di volume iniziale ("1. Nevernight - ..." -> "Nevernight - ..."). */
function withoutVolumeNumber(title: string): string {
  return title.replace(/^\s*\d+\s*[.:)\-]\s+/, '');
}

function mainTitle(title: string): string {
  const stripped = withoutVolumeNumber(title);
  const cut = stripped.split(/:|\.\s|\s[-\u2013\u2014]\s|\s\(/)[0] ?? stripped;
  return normalizeText(cut.replace(/[()]/g, ' '));
}

/** Titolo completo normalizzato, senza numero di volume ne' parentesi. */
function fullTitle(title: string): string {
  return normalizeText(withoutVolumeNumber(title).replace(/\([^)]*\)/g, ' '));
}

/**
 * Schede che sono la stessa opera dei metadati indicati: stesso primo autore e
 * titolo uguale, oppure stesso titolo principale, oppure stessa serie e stesso
 * volume. Mai per semplice contenimento («After» non e' «After We Collided»).
 */
export function findSameWork(
  meta: { title: string; authors: string[]; series: string; seriesIndex: number | null },
  index: BookMeta[],
  excludeId?: string,
): BookMeta[] {
  const author = normalizeText(meta.authors?.[0] ?? '');
  if (!author) return [];
  const title = normalizeText(meta.title ?? '');
  const main = mainTitle(meta.title ?? '');
  const series = normalizeText(meta.series ?? '');
  return index.filter((book) => {
    if (book.id === excludeId) return false;
    if (normalizeText(book.authors?.[0] ?? '') !== author) return false;
    const bookTitle = normalizeText(book.title ?? '');
    if (title && bookTitle === title) return true;
    // Il titolo principale di uno deve coincidere con il titolo completo
    // dell'altro: "Nevernight - Mai dimenticare" e' "Nevernight", ma
    // "Zodiac Academy - The Awakening" non e' "Zodiac Academy - Ruthless Fae"
    // (stesso prefisso, volumi diversi).
    const bookMain = mainTitle(book.title ?? '');
    if (main.length >= 3 && main === fullTitle(book.title ?? '')) return true;
    if (bookMain.length >= 3 && bookMain === fullTitle(meta.title ?? '')) return true;
    return Boolean(
      series &&
        meta.seriesIndex != null &&
        normalizeText(book.series ?? '') === series &&
        book.seriesIndex === meta.seriesIndex,
    );
  });
}

/**
 * Controlli sui soli metadati (ISBN, poi titolo e primo autore normalizzati):
 * usato anche per valutare un libro prima di averne il file.
 */
export async function findDuplicateByMeta(meta: {
  title?: string;
  authors?: string[];
  isbn?: string;
}): Promise<DuplicateMatch | null> {
  const index = await loadIndex();
  const isbn = normalizeIsbn(meta.isbn ?? '');
  if (isbn) {
    const found = index.find((book) => normalizeIsbn(book.isbn) === isbn);
    if (found) return { reason: 'isbn', book: found };
  }

  const title = normalizeText(meta.title ?? '');
  if (title) {
    const author = normalizeText(meta.authors?.[0] ?? '');
    const found = index.find(
      (book) =>
        normalizeText(book.title ?? '') === title &&
        normalizeText(book.authors?.[0] ?? '') === author,
    );
    if (found) return { reason: 'title', book: found };
  }
  return null;
}

export async function importFile(filePath: string, intoFolder?: string): Promise<BookMeta> {
  const settings = await loadSettings();
  const root = settings.libraryRoot;
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('Il percorso indicato non e\' un file');

  const info = await extractInfo(filePath);
  const built = buildMetaFromInfo(info, path.basename(filePath));

  const authors = built.authors?.length ? built.authors.join(', ') : '';
  const title = built.title || path.basename(filePath, path.extname(filePath));
  const baseName = authors ? `${authors} - ${title}` : title;
  let folderName = sanitizeFolderName(baseName);

  // Se la cartella e' gia' di un altro libro non la si riusa: si sovrascriverebbe
  // la sua scheda (id, modifiche manuali, voto, stato di lettura).
  if (!intoFolder) {
    const taken = await fsp
      .stat(path.join(root, folderName))
      .then(() => true)
      .catch(() => false);
    if (taken) {
      const inIndex = (await loadIndex()).some((book) => book.folder === folderName);
      const hasJson = await fsp
        .stat(path.join(root, folderName, BOOK_JSON))
        .then(() => true)
        .catch(() => false);
      if (inIndex || hasJson) folderName = await uniqueFolderName(root, baseName);
    }
  }

  const targetFolder = intoFolder ?? path.join(root, folderName);
  await fsp.mkdir(targetFolder, { recursive: true });

  const fileName = path.basename(filePath);
  const destination = path.join(targetFolder, fileName);
  const sourceAbsolute = path.resolve(filePath);
  const destinationAbsolute = path.resolve(destination);

  if (sourceAbsolute !== destinationAbsolute) {
    // Se il file e' gia' dentro la libreria lo spostiamo, cosi' non resta
    // duplicato nella radice e non viene reimportato alla scansione successiva.
    const insideLibrary = sourceAbsolute.startsWith(path.resolve(root) + path.sep);
    if (insideLibrary) {
      await fsp.rename(sourceAbsolute, destinationAbsolute).catch(async () => {
        await fsp.copyFile(sourceAbsolute, destinationAbsolute);
        await fsp.rm(sourceAbsolute, { force: true });
      });
    } else {
      await fsp.copyFile(sourceAbsolute, destinationAbsolute);
    }
  }

  const meta = emptyMeta();
  Object.assign(meta, built);
  meta.folder = path.relative(root, targetFolder);
  meta.sourceFile = fileName;
  meta.format = detectFormat(fileName);
  meta.extraFiles = (await listMediaFiles(targetFolder)).filter((f) => f !== fileName);
  meta.fieldSource = Object.fromEntries(Object.keys(built).map((key) => [key, 'file']));
  meta.dateAdded = new Date().toISOString();
  meta.dateModified = meta.dateAdded;

  // Copertina: quella estratta dal documento, se presente.
  if (info.cover) {
    const ext = info.cover.ext === '.jpeg' ? '.jpg' : info.cover.ext;
    const coverName = `cover${ext}`;
    await fsp.writeFile(path.join(targetFolder, coverName), info.cover.data);
    meta.coverFile = coverName;
  } else {
    meta.coverFile = await findCoverFile(targetFolder);
  }

  await writeBookJson(targetFolder, meta);

  const index = await loadIndex();
  const others = index.filter((book) => book.folder !== meta.folder);
  await saveIndex([...others, meta]);

  if (settings.autoLookup) {
    await autoFillFromOnline(meta);
    const updated = (await loadIndex()).find((book) => book.id === meta.id);
    return updated ?? meta;
  }
  return meta;
}

/** Aggiorna i metadati di un libro e li scrive su disco. */
export async function updateBook(
  id: string,
  patch: Partial<BookMeta>,
  source: 'manual' | 'online' | 'file' = 'manual',
): Promise<BookMeta> {
  const index = await loadIndex();
  const position = index.findIndex((book) => book.id === id);
  if (position === -1) throw new Error('Libro non trovato');

  const current = index[position];
  // Ogni descrizione salvata (risultato online, file, modifica a mano) passa da
  // qui: l'eventuale HTML diventa testo semplice.
  if (typeof patch.description === 'string') {
    patch = { ...patch, description: htmlToText(patch.description) };
  }
  // I tag composti (da provider, file o modifica manuale) diventano tag singoli.
  if (Array.isArray(patch.tags)) {
    patch = { ...patch, tags: normalizeTags(patch.tags) };
  }
  const next: BookMeta = { ...current, ...patch };
  next.id = current.id;
  next.dateAdded = current.dateAdded;
  next.dateModified = new Date().toISOString();

  const fieldSource = { ...current.fieldSource };
  for (const key of Object.keys(patch)) {
    fieldSource[key] = source;
  }
  next.fieldSource = fieldSource;

  const settings = await loadSettings();
  const folderPath = path.join(settings.libraryRoot, current.folder);
  await writeBookJson(folderPath, next);

  index[position] = next;
  await saveIndex(index);
  return next;
}

/** Applica i campi di un candidato (risultato online o del file). */
export async function applyCandidate(
  id: string,
  candidate: MetadataCandidate,
  onlyEmpty = false,
): Promise<BookMeta> {
  const current = await getBookMeta(id);
  const patch: Partial<BookMeta> = {};

  for (const [key, value] of Object.entries(candidate.fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (onlyEmpty && current) {
      const existing = (current as unknown as Record<string, unknown>)[key];
      const empty =
        existing === undefined ||
        existing === null ||
        existing === '' ||
        (Array.isArray(existing) && existing.length === 0);
      if (!empty) continue;
    }
    (patch as Record<string, unknown>)[key] = value;
  }

  if (candidate.coverUrl && (!current?.coverFile || !onlyEmpty)) {
    try {
      await downloadCoverToFolder(id, candidate.coverUrl);
    } catch {
      /* la copertina non e' bloccante: i metadati restano comunque applicati */
    }
  }
  return updateBook(id, patch, 'online');
}

/**
 * Compila automaticamente i metadati mancanti dai provider online.
 * Viene usato solo se la ricerca trova un candidato affine (punteggio alto).
 */
export async function autoFillFromOnline(meta: BookMeta): Promise<BookMeta> {
  const settings = await loadSettings();
  if (!settings.autoLookup) return meta;
  if (meta.description && meta.publisher && meta.coverFile) return meta;

  try {
    const outcome = await lookupOnline(meta, settings.providers, settings.searchLanguage, {
      googleBooksApiKey: settings.googleBooksApiKey,
    });
    const best = pickBestCandidate(meta, outcome.candidates);
    if (!best) return meta;
    return await applyCandidate(meta.id, best, true);
  } catch {
    return meta;
  }
}

/** Salva (o sostituisce) la copertina di un libro. */
export async function setCover(id: string, data: Buffer, ext: string): Promise<BookMeta> {
  const record = await getBookRecord(id);
  if (!record) throw new Error('Libro non trovato');
  const settings = await loadSettings();
  const folderPath = path.join(settings.libraryRoot, record.meta.folder);

  const normalizedExt = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const fileName = `cover${normalizedExt === '.jpeg' ? '.jpg' : normalizedExt}`;

  // Rimuove la copertina precedente se l'estensione cambia.
  if (record.meta.coverFile && record.meta.coverFile !== fileName) {
    await fsp.rm(path.join(folderPath, record.meta.coverFile), { force: true });
  }
  await fsp.writeFile(path.join(folderPath, fileName), data);
  return updateBook(id, { coverFile: fileName });
}

/** Riestrae la copertina incorporata nel file sorgente, sostituendo quella attuale. */
export async function extractCoverFromFile(id: string): Promise<BookMeta> {
  const record = await getBookRecord(id);
  if (!record) throw new Error('Libro non trovato');
  if (!record.sourcePath) throw new Error('Nessun file sorgente associato');
  const info = await extractInfo(record.sourcePath);
  if (!info.cover) throw new Error('Il file non contiene una copertina');
  return setCover(id, info.cover.data, info.cover.ext);
}

export async function removeCover(id: string): Promise<BookMeta> {
  const record = await getBookRecord(id);
  if (!record) throw new Error('Libro non trovato');
  const settings = await loadSettings();
  const folderPath = path.join(settings.libraryRoot, record.meta.folder);
  if (record.meta.coverFile) {
    await fsp.rm(path.join(folderPath, record.meta.coverFile), { force: true });
  }
  return updateBook(id, { coverFile: null });
}

/** Scarica una copertina da un URL e la imposta come copertina del libro. */
export async function downloadCoverToFolder(id: string, url: string): Promise<BookMeta> {
  const response = await safeFetch(url, {
    headers: { 'User-Agent': 'books-editor/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Download copertina fallito: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error('La risposta non e\' un\'immagine');
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = contentType.includes('png')
    ? '.png'
    : contentType.includes('webp')
      ? '.webp'
      : contentType.includes('gif')
        ? '.gif'
        : '.jpg';
  return setCover(id, buffer, ext);
}

/** Riestrae i metadati dal file sorgente, senza sovrascrivere i campi manuali. */
export async function refreshFromFile(id: string): Promise<BookMeta> {
  const record = await getBookRecord(id);
  if (!record) throw new Error('Libro non trovato');
  if (!record.sourcePath) throw new Error('Nessun file sorgente associato');
  const info = await extractInfo(record.sourcePath);
  const built = buildMetaFromInfo(info, path.basename(record.sourcePath));

  const current = record.meta;
  const patch: Record<string, unknown> = {};
  const currentRecord = current as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(built)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const currentValue = currentRecord[key];
    const wasManual = current.fieldSource?.[key] === 'manual';
    if (wasManual) continue;
    const isEmpty =
      currentValue === undefined ||
      currentValue === null ||
      currentValue === '' ||
      (Array.isArray(currentValue) && currentValue.length === 0);
    if (isEmpty) {
      patch[key] = value;
    } else if (JSON.stringify(currentValue) !== JSON.stringify(value)) {
      // Non sovrascriviamo i dati manuali, ma aggiorniamo quelli automatici
      // divergenti (anche array e numeri: es. tags e capitoli delle fanfic).
      patch[key] = value;
    }
  }
  if (info.cover && !current.coverFile) {
    const ext = info.cover.ext === '.jpeg' ? '.jpg' : info.cover.ext;
    const settings = await loadSettings();
    const folderPath = path.join(settings.libraryRoot, current.folder);
    await fsp.writeFile(path.join(folderPath, `cover${ext}`), info.cover.data);
    patch.coverFile = `cover${ext}`;
  }
  return updateBook(id, patch as Partial<BookMeta>, 'file');
}

/* ---------------------------------------------------------------- lingue -- */

const BACKUP_DIR = '.backup';

/** Nome libero in una cartella: "nome (2).ext" se quello richiesto esiste gia'. */
async function freeFileName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let counter = 2;
  while (await fsp.stat(path.join(dir, candidate)).then(() => true).catch(() => false)) {
    candidate = `${base} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

/** Sposta un file (rename, o copia + rimozione se serve) e ne restituisce il nome finale. */
async function moveInto(source: string, dir: string, name: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const finalName = await freeFileName(dir, name);
  const destination = path.join(dir, finalName);
  await fsp.rename(source, destination).catch(async () => {
    await fsp.copyFile(source, destination);
    await fsp.rm(source, { force: true });
  });
  return finalName;
}

/** Lingua e titolo di un file, con ripiego sul nome se non si riesce a leggerlo. */
async function describeFile(filePath: string): Promise<{ language: string; title: string }> {
  try {
    const info = await extractInfo(filePath);
    const built = buildMetaFromInfo(info, path.basename(filePath));
    return { language: await fileLanguage(filePath, info), title: built.title ?? '' };
  } catch {
    return { language: '', title: path.basename(filePath, path.extname(filePath)) };
  }
}

/** Nome di un file della scheda identico (per contenuto) a quello indicato, o null. */
export async function findIdenticalFile(book: BookMeta, filePath: string): Promise<string | null> {
  const settings = await loadSettings();
  const size = (await fsp.stat(filePath)).size;
  let hash: string | null = null;
  for (const name of [book.sourceFile, ...(book.extraFiles ?? [])]) {
    if (!name) continue;
    const candidate = path.join(settings.libraryRoot, book.folder, name);
    try {
      const stat = await fsp.stat(candidate);
      if (!stat.isFile() || stat.size !== size) continue;
      hash ??= await hashFile(filePath);
      if ((await hashFile(candidate)) === hash) return name;
    } catch {
      // File mancante o illeggibile: si passa oltre.
    }
  }
  return null;
}

/**
 * Aggiunge un file come edizione in un'altra lingua di un libro: lo sposta (se
 * sta gia' nella libreria) o lo copia nella cartella del libro, senza toccare
 * gli altri campi della scheda.
 */
export async function attachEdition(bookId: string, filePath: string): Promise<BookMeta> {
  const book = await getBookMeta(bookId);
  if (!book) throw new Error('Libro non trovato');
  if (!book.sourceFile) throw new Error('La scheda non ha un file principale');
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('Il percorso indicato non e\' un file');
  if (!MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error('Formato del file non supportato');
  }
  if (await findIdenticalFile(book, filePath)) {
    throw new Error('Questo file e\' gia\' presente nella scheda');
  }

  const settings = await loadSettings();
  const root = path.resolve(settings.libraryRoot);
  const folderPath = path.join(root, book.folder);
  const { language, title } = await describeFile(filePath);

  const sourceAbsolute = path.resolve(filePath);
  const name = path.basename(filePath);
  let fileName: string;
  if (sourceAbsolute.startsWith(root + path.sep)) {
    fileName = await moveInto(sourceAbsolute, folderPath, name);
  } else {
    await fsp.mkdir(folderPath, { recursive: true });
    fileName = await freeFileName(folderPath, name);
    await fsp.copyFile(sourceAbsolute, path.join(folderPath, fileName));
  }

  const edition: BookEdition = { file: fileName, language, title };
  return updateBook(
    bookId,
    {
      editions: [...(book.editions ?? []), edition],
      extraFiles: [...(book.extraFiles ?? []), fileName],
    },
    'file',
  );
}

/**
 * Toglie un'edizione dalla scheda: il file va in `<cartella>/.backup/`, non
 * viene cancellato. Non vale per l'edizione principale.
 */
export async function removeEdition(bookId: string, file: string): Promise<BookMeta> {
  const book = await getBookMeta(bookId);
  if (!book) throw new Error('Libro non trovato');
  if (file === book.sourceFile) throw new Error('L\'edizione principale non si puo\' rimuovere');
  const editions = book.editions ?? [];
  if (!editions.some((edition) => edition.file === file)) {
    throw new Error('Edizione non trovata in questa scheda');
  }
  const settings = await loadSettings();
  const folderPath = path.join(settings.libraryRoot, book.folder);
  const filePath = path.join(folderPath, file);
  if (await fsp.stat(filePath).then((s) => s.isFile()).catch(() => false)) {
    await moveInto(filePath, path.join(folderPath, BACKUP_DIR), file);
  }
  return updateBook(
    bookId,
    {
      editions: editions.filter((edition) => edition.file !== file),
      extraFiles: (book.extraFiles ?? []).filter((name) => name !== file),
    },
    'file',
  );
}

/** Altre schede che sono probabilmente la stessa opera (in sola lettura). */
export async function editionSuggestions(bookId: string): Promise<BookMeta[]> {
  const index = await loadIndex();
  const book = index.find((b) => b.id === bookId);
  if (!book) throw new Error('Libro non trovato');
  return findSameWork(book, index, book.id);
}

export interface MergeResult {
  book: BookMeta;
  /** true se la cartella dell'altra scheda e' stata cancellata. */
  folderRemoved: boolean;
  /** Spiegazione, se la cartella e' rimasta. */
  note?: string;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)
  );
}

/** Istante usato per decidere "il piu' recente": ultima lettura, altrimenti modifica. */
function recency(book: BookMeta, useLastRead: boolean): number {
  const stamp = (useLastRead ? book.lastRead : null) || book.dateModified;
  const time = Date.parse(stamp ?? '');
  return Number.isFinite(time) ? time : 0;
}

/**
 * Unisce la scheda `otherId` in `targetId`: i file dell'altra diventano
 * edizioni (altre lingue) del target, i dati personali si combinano e l'altra
 * scheda sparisce dall'indice.
 */
export async function mergeBooks(targetId: string, otherId: string): Promise<MergeResult> {
  if (targetId === otherId) throw new Error('Non si puo\' unire una scheda con se stessa');
  const index = await loadIndex();
  const target = index.find((b) => b.id === targetId);
  const other = index.find((b) => b.id === otherId);
  if (!target || !other) throw new Error('Libro non trovato');
  if (!target.sourceFile) throw new Error('La scheda di destinazione non ha un file principale');

  const settings = await loadSettings();
  const root = settings.libraryRoot;
  const targetPath = path.join(root, target.folder);
  const otherPath = path.join(root, other.folder);

  // 1) File: ognuno finisce nella cartella del target come edizione.
  const incoming: Array<{ file: string; language: string; title: string }> = [];
  if (other.sourceFile) {
    incoming.push({
      file: other.sourceFile,
      language: toIso6391(other.language ?? '') ?? '',
      title: other.title,
    });
  }
  for (const edition of other.editions ?? []) incoming.push({ ...edition });
  const listed = new Set(incoming.map((item) => item.file));
  for (const name of other.extraFiles ?? []) {
    if (listed.has(name)) continue;
    incoming.push({ file: name, ...(await describeFile(path.join(otherPath, name))) });
  }

  const newEditions: BookEdition[] = [];
  for (const item of incoming) {
    const from = path.join(otherPath, item.file);
    if (!(await fsp.stat(from).then((s) => s.isFile()).catch(() => false))) continue;
    const finalName = await moveInto(from, targetPath, item.file);
    newEditions.push({ file: finalName, language: item.language, title: item.title });
  }

  // Backup dell'altra scheda: restano recuperabili nella cartella del target.
  const otherBackup = path.join(otherPath, BACKUP_DIR);
  const backupEntries = await fsp.readdir(otherBackup, { withFileTypes: true }).catch(() => []);
  for (const entry of backupEntries) {
    if (!entry.isFile()) continue;
    await moveInto(
      path.join(otherBackup, entry.name),
      path.join(targetPath, BACKUP_DIR),
      entry.name,
    );
  }

  // 2) Dati: voto e stato di lettura secondo il piu' recente, il resto combinato.
  const merged: BookMeta = { ...target };
  const both = [target, other];

  const rated = both.filter((book) => book.rating != null);
  rated.sort((a, b) => recency(b, false) - recency(a, false));
  merged.rating = rated[0]?.rating ?? null;

  const withStatus = both.filter((book) => book.readingStatus && book.readingStatus !== 'unread');
  withStatus.sort((a, b) => recency(b, true) - recency(a, true));
  const winner = withStatus[0];
  merged.readingStatus = winner?.readingStatus ?? 'unread';
  if (winner && winner.id !== target.id) {
    // Avanzamento e data di fine accompagnano lo stato scelto.
    merged.readingProgress = winner.readingProgress;
    merged.dateFinished = winner.dateFinished;
  }

  merged.favorite = Boolean(target.favorite || other.favorite);
  const lastReads = both.map((book) => book.lastRead).filter((v): v is string => Boolean(v));
  merged.lastRead = lastReads.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const seenHighlights = new Set<string>();
  merged.highlights = [...(target.highlights ?? []), ...(other.highlights ?? [])].filter((h) => {
    if (!h.id) return true;
    if (seenHighlights.has(h.id)) return false;
    seenHighlights.add(h.id);
    return true;
  });
  merged.notes = [target.notes, other.notes].filter((n) => n && n.trim()).join('\n\n');
  const tagKeys = new Set<string>();
  merged.tags = [...(target.tags ?? []), ...(other.tags ?? [])].filter((tag) => {
    const key = tag.toLowerCase();
    if (tagKeys.has(key)) return false;
    tagKeys.add(key);
    return true;
  });

  // 3) Metadati bibliografici: quelli del target, completati dove sono vuoti.
  const fieldSource = { ...target.fieldSource };
  const fillable = [
    'subtitle', 'authors', 'series', 'seriesIndex', 'publisher', 'publishedDate',
    'language', 'isbn', 'identifiers', 'description', 'pageCount', 'fandom', 'ships',
    'characters', 'relationships', 'fanRating', 'status', 'chapters', 'ao3Url', 'ffnetUrl',
    'efpUrl',
  ] as const;
  for (const key of fillable) {
    const mine = (merged as unknown as Record<string, unknown>)[key];
    const theirs = (other as unknown as Record<string, unknown>)[key];
    if (isEmptyValue(mine) && !isEmptyValue(theirs)) {
      (merged as unknown as Record<string, unknown>)[key] = theirs;
      fieldSource[key] = other.fieldSource?.[key] ?? 'file';
    }
  }
  if (!merged.coverFile && other.coverFile) {
    const from = path.join(otherPath, other.coverFile);
    if (await fsp.stat(from).then((s) => s.isFile()).catch(() => false)) {
      const coverName = await freeFileName(targetPath, other.coverFile);
      await fsp.copyFile(from, path.join(targetPath, coverName));
      merged.coverFile = coverName;
    }
  }

  merged.editions = [...(target.editions ?? []), ...newEditions];
  merged.extraFiles = [...(target.extraFiles ?? []), ...newEditions.map((e) => e.file)];
  merged.fieldSource = fieldSource;
  merged.dateModified = new Date().toISOString();

  await writeBookJson(targetPath, merged);
  await saveIndex(index.filter((book) => book.id !== otherId).map((b) => (b.id === targetId ? merged : b)));

  // 4) Pulizia: la cartella dell'altra scheda va solo se non contiene altro che
  //    book.json, copertine e una .backup vuota.
  let folderRemoved = false;
  let note: string | undefined;
  if (path.resolve(otherPath) === path.resolve(targetPath)) {
    note = 'Le due schede condividevano la stessa cartella: non e\' stata toccata';
  } else {
    await fsp.rmdir(otherBackup).catch(() => undefined);
    const rest = await fsp.readdir(otherPath, { withFileTypes: true }).catch(() => null);
    if (rest) {
      const leftovers = rest.filter(
        (entry) =>
          !(
            entry.isFile() &&
            (entry.name === BOOK_JSON ||
              entry.name === `${BOOK_JSON}.tmp` ||
              IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
          ),
      );
      if (leftovers.length === 0) {
        await fsp.rm(otherPath, { recursive: true, force: true });
        folderRemoved = true;
      } else {
        // Il book.json resterebbe una scheda "fantasma" alla scansione: lo si mette da parte.
        await fsp
          .rename(path.join(otherPath, BOOK_JSON), path.join(otherPath, `${BOOK_JSON}.unito`))
          .catch(() => undefined);
        note = `La cartella «${other.folder}» contiene altri file (${leftovers
          .map((entry) => entry.name)
          .join(', ')}) e non e' stata cancellata`;
      }
    }
  }
  return { book: merged, folderRemoved, note };
}

export async function listBooks(): Promise<BookSummary[]> {
  const index = await loadIndex();
  return index.map(toSummary);
}
