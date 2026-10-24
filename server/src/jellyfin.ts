import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadIndex, loadSettings } from './store.js';
import {
  MEDIA_EXTENSIONS,
  findDuplicate,
  findDuplicateByMeta,
  attachEdition,
  importFile,
  normalizeText,
  prepareImport,
  updateBook,
} from './library.js';
import type { PreparedImport } from './library.js';
import { conversionSupport } from './convert.js';
import { htmlToText } from './htmlText.js';
import { syncAppleBooksForBooks } from './appleBooks.js';
import type { BookMeta } from '../../shared/types.js';

const API_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 200;
const ITEM_FIELDS = 'Path,Overview,Genres,Tags,ProviderIds,People,PremiereDate,ProductionYear';

/** Errore con messaggio leggibile, pensato per essere mostrato all'utente. */
export class JellyfinError extends Error {}

export interface JellyfinInfo {
  serverName: string;
  version: string;
}

export interface JellyfinLibrary {
  id: string;
  name: string;
  type: string;
}

interface JellyfinItem {
  Id: string;
  Name?: string;
  Path?: string;
  Overview?: string;
  Genres?: string[];
  Tags?: string[];
  ProviderIds?: Record<string, string>;
  People?: Array<{ Name?: string; Type?: string }>;
  SeriesName?: string;
  IndexNumber?: number;
  ProductionYear?: number;
}

export type JellyfinStatus = 'new' | 'duplicate' | 'imported' | 'unsupported';

export interface JellyfinPreviewItem {
  id: string;
  title: string;
  authors: string[];
  format: string;
  status: JellyfinStatus;
  existing?: { id: string; title: string };
  /** Per i duplicati: gia' in libreria, oppure altra copia dentro Jellyfin. */
  reason?: 'library' | 'jellyfin-copy';
  /** Nome del file illeggibile: il controllo dei doppioni avviene dopo il download. */
  uncertain?: boolean;
}

export interface JellyfinPreview {
  total: number;
  /** `uncertain` e' un sottoinsieme di `new`. */
  counts: Record<JellyfinStatus, number> & { uncertain: number };
  items: JellyfinPreviewItem[];
}

export interface JellyfinImportState {
  running: boolean;
  libraryId: string;
  total: number;
  done: number;
  imported: Array<{ id: string; title: string; kind?: 'book' | 'fanfic' }>;
  duplicates: Array<{ title: string; existing: string }>;
  /** File aggiunti come altra lingua di un libro gia' presente. */
  editions: Array<{ title: string; book: string; language: string }>;
  skipped: number;
  errors: Array<{ title: string; message: string }>;
  startedAt: string;
  finishedAt: string | null;
}

async function credentials(): Promise<{ url: string; key: string }> {
  const settings = await loadSettings();
  const url = (settings.jellyfinUrl ?? '').trim().replace(/\/+$/, '');
  const key = (settings.jellyfinApiKey ?? '').trim();
  if (!url) throw new JellyfinError('Indirizzo Jellyfin mancante: impostalo nelle Impostazioni');
  if (!key) throw new JellyfinError('Chiave API Jellyfin mancante: impostala nelle Impostazioni');
  return { url, key };
}

/** Richiesta a Jellyfin con chiave API, timeout ed errori in italiano. */
export async function jellyfinFetch(
  pathAndQuery: string,
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  const { url, key } = await credentials();
  let response: Response;
  try {
    response = await fetch(`${url}${pathAndQuery}`, {
      // Jellyfin 10.11+ ha disattivato i metodi legacy (X-Emby-Token, ?api_key=):
      // l'header Authorization funziona su tutte le versioni.
      headers: { Authorization: `MediaBrowser Token="${key}"`, Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new JellyfinError('Jellyfin non ha risposto in tempo');
    }
    throw new JellyfinError(`Server Jellyfin non raggiungibile (${url})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new JellyfinError('Chiave API Jellyfin non valida o senza permessi');
  }
  return response;
}

async function jellyfinJson<T>(pathAndQuery: string): Promise<T> {
  const response = await jellyfinFetch(pathAndQuery);
  if (!response.ok) throw new JellyfinError(`Jellyfin ha risposto con errore ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new JellyfinError('Risposta di Jellyfin non valida (l\'indirizzo e\' corretto?)');
  }
}

export async function getJellyfinInfo(): Promise<JellyfinInfo> {
  // L'endpoint pubblico non verifica la chiave: la si prova subito dopo con le librerie.
  const info = await jellyfinJson<{ ServerName?: string; Version?: string }>('/System/Info/Public');
  await jellyfinJson('/Library/VirtualFolders');
  return { serverName: info.ServerName ?? 'Jellyfin', version: info.Version ?? '' };
}

export async function listJellyfinLibraries(): Promise<JellyfinLibrary[]> {
  const folders = await jellyfinJson<
    Array<{ Name?: string; ItemId?: string; CollectionType?: string }>
  >('/Library/VirtualFolders');
  const libraries = folders
    .filter((folder) => folder.ItemId)
    .map((folder) => ({
      id: folder.ItemId as string,
      name: folder.Name ?? folder.ItemId as string,
      type: folder.CollectionType ?? '',
    }));
  // Prima le librerie di libri e, fra queste, quella chiamata "Books"/"Libri":
  // Jellyfin usa il tipo "books" anche per manga, fumetti e riviste.
  const rank = (library: JellyfinLibrary): number =>
    library.type !== 'books' ? 2 : /^(books?|libri|ebooks?)$/i.test(library.name.trim()) ? 0 : 1;
  return [...libraries].sort((left, right) => rank(left) - rank(right));
}

async function adminUserId(): Promise<string> {
  const users = await jellyfinJson<Array<{ Id: string; Policy?: { IsAdministrator?: boolean } }>>(
    '/Users',
  );
  const user = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
  if (!user) throw new JellyfinError('Nessun utente trovato su Jellyfin');
  return user.Id;
}

/** Tutti i libri di una libreria, paginando. */
export async function listJellyfinBooks(libraryId: string): Promise<JellyfinItem[]> {
  const items: JellyfinItem[] = [];
  let userId: string | null = null;
  let start = 0;
  for (;;) {
    const query =
      `ParentId=${encodeURIComponent(libraryId)}&Recursive=true&IncludeItemTypes=Book` +
      `&Fields=${ITEM_FIELDS}&StartIndex=${start}&Limit=${PAGE_SIZE}`;
    let response = await jellyfinFetch(userId ? `/Users/${userId}/Items?${query}` : `/Items?${query}`);
    // Alcune versioni rispondono 400 senza utente: si ripete come utente.
    if (response.status === 400 && !userId) {
      userId = await adminUserId();
      response = await jellyfinFetch(`/Users/${userId}/Items?${query}`);
    }
    if (!response.ok) throw new JellyfinError(`Jellyfin ha risposto con errore ${response.status}`);
    const page = (await response.json()) as { Items?: JellyfinItem[]; TotalRecordCount?: number };
    const batch = page.Items ?? [];
    items.push(...batch);
    start += batch.length;
    if (!batch.length || start >= (page.TotalRecordCount ?? 0)) break;
  }
  return items;
}

function itemAuthors(item: JellyfinItem): string[] {
  const names = (item.People ?? [])
    .filter((p) => p.Name && /^(author|writer)$/i.test(p.Type ?? ''))
    .map((p) => (p.Name as string).trim());
  return [...new Set(names)];
}

function itemIsbn(item: JellyfinItem): string {
  for (const [key, value] of Object.entries(item.ProviderIds ?? {})) {
    if (/^isbn/i.test(key) && value) return value;
  }
  return '';
}

function itemExt(item: JellyfinItem): string {
  return path.extname(item.Path ?? '').toLowerCase();
}

function itemTitle(item: JellyfinItem): string {
  return (item.Name ?? '').trim() || path.basename(item.Path ?? '', itemExt(item)) || item.Id;
}

/* ------------------------------------------- interpretazione dei nomi file -- */

export interface ParsedBookName {
  /** Le due parti separate da " - ": l'ordine Autore - Titolo non e' garantito. */
  parts: [string, string];
  /** Ipotesi piu' comune "Autore - Titolo": titolo = seconda parte. */
  title: string;
  authors: string[];
  series: string;
  seriesIndex: number | null;
}

/** "Cognome, Nome" diventa "Nome Cognome". */
function flipAuthor(value: string): string {
  const pieces = value.split(',').map((piece) => piece.trim());
  if (pieces.length === 2 && pieces[0] && pieces[1]) return `${pieces[1]} ${pieces[0]}`;
  return value.trim();
}

/**
 * Interpreta il nome file di un libro senza metadati, es.
 * "(Serie 1) Cognome, Nome - Titolo" oppure "Autore - Titolo".
 * Restituisce null se il nome non e' interpretabile (solo numeri, niente " - ").
 */
export function parseBookFileName(name: string): ParsedBookName | null {
  // Nomi solo numerici (download da Telegram): nessuna informazione.
  if (/^[\d\s_]*$/.test(name)) return null;
  let text = name.replace(/_-_/g, ' - ').replace(/\s+/g, ' ').trim();
  let series = '';
  let seriesIndex: number | null = null;
  // Prefisso "(Serie N)" oppure "[Serie N]".
  const prefix = text.match(/^[([]([^()[\]]*?)(?:\s+_?(\d+(?:\.\d+)?))?\s*[)\]]\s*(.*)$/);
  if (prefix && prefix[1].trim()) {
    series = prefix[1].trim().replace(/_/g, ' ');
    if (prefix[2]) seriesIndex = Number(prefix[2]);
    text = prefix[3];
  }
  // Un "_" staccato da uno spazio e' un ":" (es. "Zodiac Academy_ The Awakening"),
  // gli altri "_" sono spazi. Il ":" resta poi un separatore fra i pezzi del titolo.
  text = text
    .replace(/(\s_+|_+\s)/g, ' : ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Suffissi tipo "(1)", "(2)", "(2016)" in fondo.
  for (;;) {
    const stripped = text.replace(/\s*\(\d{1,4}\)\s*$/, '');
    if (stripped === text) break;
    text = stripped;
  }
  const at = text.indexOf(' - ');
  if (at < 0) return null;
  const left = text.slice(0, at).trim();
  const right = text.slice(at + 3).trim();
  if (!left || !right) return null;
  return { parts: [left, right], title: right, authors: [flipAuthor(left)], series, seriesIndex };
}

export interface LibraryNameIndex {
  entries: Array<{ book: BookMeta; titles: string[]; surname: string }>;
}

/** Titoli con cui un libro puo' comparire in un nome file: completo e principale. */
function bookTitleVariants(title: string): string[] {
  const variants = new Set<string>([normalizeText(title)]);
  const colon = title.indexOf(':');
  if (colon > 0) variants.add(normalizeText(title.slice(0, colon)));
  // Forma "Titolo. Serie. Vol. N": il titolo principale e' prima di ". ".
  const dot = title.search(/\.\s/);
  if (dot > 0 && /\.\s.*\bvol\b/i.test(title)) variants.add(normalizeText(title.slice(0, dot)));
  return [...variants].filter((variant) => variant.length >= 3);
}

/** Normalizza una volta sola i libri dell'indice per i confronti sul nome. */
export function buildNameIndex(books: Array<Pick<BookMeta, 'title' | 'authors'> & Partial<BookMeta>>): LibraryNameIndex {
  const entries: LibraryNameIndex['entries'] = [];
  for (const book of books) {
    const titles = bookTitleVariants(book.title ?? '');
    // Alcuni autori in indice sono "Cognome, Nome": il cognome e' prima della virgola.
    const rawAuthor = book.authors?.[0] ?? '';
    const surname = rawAuthor.includes(',')
      ? normalizeText(rawAuthor.split(',')[0])
      : (normalizeText(rawAuthor).split(' ').pop() ?? '');
    // Titoli troppo corti o libri senza autore danno solo falsi positivi.
    if (!titles.length || surname.length < 2) continue;
    entries.push({ book: book as BookMeta, titles, surname });
  }
  return { entries };
}

/** Toglie i gruppi [...] e (...), anche se la parentesi finale e' stata troncata. */
function stripGroups(value: string): string {
  return value
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[([][^)\]]*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pezzi di una parte del nome: separati da " - ", ":" e "-" fra parole, oppure solo dai primi due. */
function namePieces(part: string): Set<string> {
  const pieces = new Set<string>();
  for (const splitter of [/\s-\s|:|(?<=\S)-(?=\S)/, /\s-\s|:/]) {
    for (const piece of part.split(splitter)) {
      const normalized = normalizeText(piece);
      if (!normalized) continue;
      pieces.add(normalized);
      // Numero di volume davanti al titolo ("2 Thunderhead").
      const withoutNumber = normalized.replace(/^\d+ /, '');
      if (withoutNumber !== normalized) pieces.add(withoutNumber);
    }
  }
  return pieces;
}

/**
 * Cerca nell'indice un libro il cui titolo (completo o principale) e' uguale a un
 * pezzo di una delle due parti del nome e il cui cognome (primo autore) compare a
 * parole intere nell'altra. Niente confronti per contenimento sul titolo.
 * A parita' vince il titolo piu' lungo.
 */
export function matchLibraryByName(parsed: ParsedBookName, index: LibraryNameIndex): BookMeta | null {
  const cleaned = parsed.parts.map(stripGroups);
  const pieces = cleaned.map(namePieces);
  const padded = cleaned.map((part) => ` ${normalizeText(part)} `);
  let best: { book: BookMeta; length: number } | null = null;
  for (const entry of index.entries) {
    const needleSurname = ` ${entry.surname} `;
    for (const title of entry.titles) {
      const hit =
        (pieces[0].has(title) && padded[1].includes(needleSurname)) ||
        (pieces[1].has(title) && padded[0].includes(needleSurname));
      if (hit && (!best || title.length > best.length)) {
        best = { book: entry.book, length: title.length };
      }
    }
  }
  return best?.book ?? null;
}

/** Nome da interpretare: quello di Jellyfin, altrimenti il file senza estensione. */
function itemRawName(item: JellyfinItem): string {
  return (item.Name ?? '').trim() || path.basename(item.Path ?? '', itemExt(item));
}

/** Priorita' del formato quando lo stesso libro esiste in piu' copie. */
function extRank(ext: string): number {
  if (ext === '.epub') return 0;
  if (ext === '.pdf') return 1;
  return MEDIA_EXTENSIONS.has(ext) ? 2 : 3; // i formati da convertire (MOBI...) dopo quelli nativi
}

/**
 * Segna come copie le ripetizioni dello stesso libro dentro Jellyfin (stesso `Name`).
 * Si tiene un solo elemento per gruppo: prima uno gia' importato, poi uno gia' in
 * libreria (cosi' tutto il gruppo risulta duplicato), poi il formato migliore
 * (epub, pdf, altre), poi l'Id piu' basso (l'ordine delle pagine non e' stabile).
 */
function markInternalCopies(items: JellyfinItem[], results: JellyfinPreviewItem[]): void {
  const byId = new Map(results.map((result) => [result.id, result]));
  const groups = new Map<string, JellyfinItem[]>();
  for (const item of items) {
    const key = normalizeText(item.Name ?? '');
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const rank = (item: JellyfinItem): number => {
      const result = byId.get(item.Id);
      if (result?.status === 'imported') return -2;
      if (result?.status === 'duplicate') return -1;
      return extRank(itemExt(item));
    };
    let keeper = group[0];
    for (const item of group) {
      if (rank(item) < rank(keeper) || (rank(item) === rank(keeper) && item.Id < keeper.Id)) keeper = item;
    }
    for (const item of group) {
      const result = byId.get(item.Id);
      if (item === keeper || !result || result.status === 'imported') continue;
      for (const field of ['existing', 'uncertain'] as const) delete result[field];
      result.status = 'duplicate';
      result.reason = 'jellyfin-copy';
    }
  }
}

async function classify(items: JellyfinItem[]): Promise<JellyfinPreviewItem[]> {
  // MOBI, AZW3, FB2, DJVU... si importano se sul server ci sono gli strumenti di conversione.
  const convertible = new Set(conversionSupport().extensions);
  const index = await loadIndex();
  const known = new Map<string, BookMeta>();
  for (const book of index) {
    const id = book.identifiers?.jellyfin;
    if (id) known.set(id, book);
  }
  const nameIndex = buildNameIndex(index);
  const result: JellyfinPreviewItem[] = [];
  for (const item of items) {
    const ext = itemExt(item);
    const base = {
      id: item.Id,
      title: itemTitle(item),
      authors: itemAuthors(item),
      format: ext.replace('.', ''),
    };
    const imported = known.get(item.Id);
    if (imported) {
      result.push({ ...base, status: 'imported', existing: { id: imported.id, title: imported.title } });
      continue;
    }
    if (!MEDIA_EXTENSIONS.has(ext) && !convertible.has(ext)) {
      result.push({ ...base, status: 'unsupported' });
      continue;
    }
    const isbn = itemIsbn(item);
    if (base.authors.length || isbn) {
      const dup = await findDuplicateByMeta({ title: base.title, authors: base.authors, isbn });
      if (dup) {
        result.push({
          ...base,
          status: 'duplicate',
          reason: 'library',
          existing: { id: dup.book.id, title: dup.book.title },
        });
        continue;
      }
    }
    const parsed = parseBookFileName(itemRawName(item));
    if (!parsed) {
      // Nome illeggibile: si controlla dopo il download, sul contenuto del file.
      result.push({ ...base, status: 'new', uncertain: true });
      continue;
    }
    const match = matchLibraryByName(parsed, nameIndex);
    if (match) {
      result.push({
        ...base,
        status: 'duplicate',
        reason: 'library',
        existing: { id: match.id, title: match.title },
      });
    } else {
      result.push({ ...base, status: 'new' });
    }
  }
  markInternalCopies(items, result);
  return result;
}

export async function previewJellyfinImport(libraryId: string): Promise<JellyfinPreview> {
  const items = await classify(await listJellyfinBooks(libraryId));
  const counts = { new: 0, duplicate: 0, imported: 0, unsupported: 0, uncertain: 0 };
  for (const item of items) {
    counts[item.status] += 1;
    if (item.status === 'new' && item.uncertain) counts.uncertain += 1;
  }
  return { total: items.length, counts, items };
}

/* ------------------------------------------------------ import in corso -- */

let currentJob: JellyfinImportState | null = null;
let starting = false;

export function getJellyfinImportState(): JellyfinImportState | null {
  return currentJob;
}

/** Scarica il file originale di un libro in `target`. */
async function downloadItem(id: string, target: string): Promise<void> {
  const response = await jellyfinFetch(`/Items/${encodeURIComponent(id)}/Download`, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  if (!response.ok || !response.body) {
    throw new JellyfinError(`Download non riuscito (errore ${response.status})`);
  }
  await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(target));
}

async function importOne(
  item: JellyfinItem,
  job: JellyfinImportState,
  staging: string,
): Promise<void> {
  const title = itemTitle(item);
  // Id ed estensione arrivano dal server: niente separatori di percorso nel nome.
  const safeId = item.Id.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeExt = itemExt(item).replace(/[^a-z0-9.]/g, '');
  const temp = path.join(staging, `jellyfin-${safeId}${safeExt}`);
  let prepared: PreparedImport | null = null;
  try {
    await downloadItem(item.Id, temp);
    // MOBI, AZW3, FB2, DJVU... vengono convertiti prima dei controlli.
    prepared = await prepareImport(temp);
    // Stesso file (o stessi metadati interni) di un libro gia' presente.
    const dup = prepared.duplicate ?? (await findDuplicate(prepared.path));
    if (dup?.reason === 'language') {
      // Stessa opera in un'altra lingua: diventa un'edizione, senza chiedere.
      await attachEdition(dup.book.id, prepared.path);
      job.editions.push({ title, book: dup.book.title, language: dup.language ?? '' });
      return;
    }
    if (dup) {
      job.duplicates.push({ title, existing: dup.book.title });
      return;
    }
    const meta = await importFile(prepared.path, undefined, { original: prepared.original });
    const patch: Partial<BookMeta> = {
      identifiers: { ...meta.identifiers, jellyfin: item.Id },
    };
    // Si completano solo i campi vuoti.
    const overview = htmlToText(item.Overview ?? '');
    if (!meta.description && overview) patch.description = overview;
    if (!meta.series && item.SeriesName) patch.series = item.SeriesName;
    if (meta.seriesIndex == null && typeof item.IndexNumber === 'number') {
      patch.seriesIndex = item.IndexNumber;
    }
    // Se Jellyfin non ha la serie, si prova dal nome file "(Serie N) ...".
    const parsed = parseBookFileName(itemRawName(item));
    if (parsed) {
      if (!meta.series && !patch.series && parsed.series) patch.series = parsed.series;
      if (meta.seriesIndex == null && patch.seriesIndex == null && parsed.seriesIndex != null) {
        patch.seriesIndex = parsed.seriesIndex;
      }
    }
    const updated = await updateBook(meta.id, patch, 'online');
    job.imported.push({ id: updated.id, title: updated.title || title, kind: updated.kind });
  } finally {
    await prepared?.cleanup();
    await fsp.rm(temp, { force: true });
  }
}

async function runJob(job: JellyfinImportState, items: JellyfinItem[]): Promise<void> {
  const settings = await loadSettings();
  const staging = path.join(settings.libraryRoot, '.uploads');
  await fsp.mkdir(staging, { recursive: true });
  for (const item of items) {
    try {
      await importOne(item, job, staging);
    } catch (error) {
      job.errors.push({ title: itemTitle(item), message: (error as Error).message });
    }
    job.done += 1;
  }
}

/** Avvia l'import in background; un solo job alla volta. */
export async function startJellyfinImport(libraryId: string): Promise<JellyfinImportState> {
  if (currentJob?.running || starting) throw new JellyfinError('Un import da Jellyfin e\' gia\' in corso');
  // Elencare i libri richiede tempo: il flag evita due avvii in parallelo.
  starting = true;
  let all: JellyfinItem[];
  let statuses: JellyfinPreviewItem[];
  try {
    all = await listJellyfinBooks(libraryId);
    statuses = await classify(all);
  } finally {
    starting = false;
  }
  const newIds = new Set(statuses.filter((s) => s.status === 'new').map((s) => s.id));
  const items = all.filter((item) => newIds.has(item.Id));
  const job: JellyfinImportState = {
    running: true,
    libraryId,
    total: items.length,
    done: 0,
    imported: [],
    duplicates: [],
    editions: [],
    skipped: statuses.length - items.length,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  currentJob = job;
  void runJob(job, items)
    .catch((error) => {
      job.errors.push({ title: '(import)', message: (error as Error).message });
    })
    .then(async () => {
      // Le opere appena scaricate possono avere sottolineature e avanzamento in
      // Apple Books: si sincronizzano prima di dichiarare finito il job, cosi'
      // la libreria ricaricata dal client e' gia' completa.
      await syncAppleBooksForBooks(job.imported.map((item) => item.id));
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
  return job;
}
