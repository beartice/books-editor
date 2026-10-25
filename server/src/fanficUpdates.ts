import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  FANFIC_CHECK_DELAY_SEC,
  FANFIC_CHECK_ENABLED,
  FANFIC_CHECK_HOUR,
  ensureDir,
} from './config.js';
import { loadEfpStory, importEfpStory, type EfpStory } from './efp.js';
import {
  buildMetaFromInfo,
  extractInfo,
  fanficSourceKeys,
  getBookMeta,
  updateBook,
} from './library.js';
import { runInLibrary, type LibraryInfo } from './libraries.js';
import { Ao3HttpError, downloadAo3File, fetchAo3WithCurl, fetchAo3WithReader } from './providers/ao3http.js';
import { fetchAo3Html, parseAo3Progress } from './providers/fanfic.js';
import { ao3SessionActive, markAo3SessionExpired } from './providers/ao3session.js';
import { loadIndexFor, loadSettings } from './store.js';
import { isFanficUpdateAvailable } from '../../shared/types.js';
import type { BookMeta, FanficCheckState, FanficUpdate } from '../../shared/types.js';

/**
 * Controllo dei nuovi capitoli delle fanfiction incomplete (AO3 ed EFP).
 * L'app avvisa soltanto: l'aggiornamento della storia lo avvia l'utente.
 * FanFiction.net e' escluso (Cloudflare blocca le richieste).
 */

const AO3_WORK = 'https://archiveofourown.org/works';
const AO3_DOWNLOADS = 'https://archiveofourown.org/downloads';
const EFP_STORY = 'https://www.efpfanfic.net/viewstory.php?sid=';
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Dopo tanti 429/503 di fila AO3 sta limitando le richieste: il giro si ferma. */
const MAX_RATE_LIMITS = 3;
const STARTUP_DELAY_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/* --------------------------------------------------------------- stato -- */

type Source = { site: 'ao3' | 'efp'; id: string };

/** Dati del sito remoto che servono al confronto con la scheda. */
export interface RemoteStory {
  chapters: number | null;
  total: number | null;
  complete: boolean;
  updated: string | null;
}

/** Parti sostituibili (rete e attese): le prove le sostituiscono con file di esempio. */
export interface FanficDeps {
  /** HTML della pagina di un'opera AO3. */
  fetchAo3Page: (url: string, timeoutMs: number) => Promise<string>;
  /** Scarica il file di AO3 in `destination`. */
  downloadAo3: (url: string, destination: string, timeoutMs: number) => Promise<void>;
  loadEfp: (url: string) => Promise<EfpStory>;
  sleep: (ms: number) => Promise<void>;
  /** Pausa fra una richiesta e l'altra. */
  delayMs: number;
  timeoutMs: number;
  /** Attesa dopo l'n-esimo 429/503 consecutivo. */
  backoffMs: (attempt: number) => number;
}

let curlAvailable: boolean | null = null;

/**
 * AO3 e' dietro Cloudflare: prima curl (connessione TLS che passa piu' spesso),
 * poi il client di Node, infine il lettore pubblico, come per le serie.
 * 404 e limiti di richieste si propagano subito, senza altri tentativi.
 */
export async function fetchAo3Work(url: string, timeoutMs: number): Promise<string> {
  const stop = (error: unknown) =>
    (error instanceof Ao3HttpError && [404, 429, 503].includes(error.status)) ||
    /non trova la pagina|Opera non trovata|troppe richieste/i.test((error as Error).message);
  let lastError: Error | null = null;

  if (curlAvailable !== false) {
    try {
      const html = await fetchAo3WithCurl(url, timeoutMs, Math.ceil(timeoutMs / 1000));
      curlAvailable = true;
      return html;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') curlAvailable = false;
      else if (stop(error)) throw error;
      else lastError = error as Error;
    }
  }

  try {
    return await fetchAo3Html(url, { timeoutMs, attempts: 2, retryTimeouts: true });
  } catch (error) {
    if (stop(error)) throw error;
    lastError = error as Error;
  }

  try {
    return await fetchAo3WithReader(url, timeoutMs);
  } catch (error) {
    throw stop(error) ? error : (lastError ?? error);
  }
}

const defaultDeps: FanficDeps = {
  fetchAo3Page: fetchAo3Work,
  downloadAo3: downloadAo3File,
  loadEfp: (url) => loadEfpStory(url, { fresh: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs: FANFIC_CHECK_DELAY_SEC * 1000,
  timeoutMs: REQUEST_TIMEOUT_MS,
  backoffMs: (attempt) => 60_000 * 2 ** (attempt - 1),
};

let deps: FanficDeps = defaultDeps;

/** Per le prove: sostituisce una parte della rete o delle attese. */
export function overrideFanficDeps(partial: Partial<FanficDeps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
}

/* ------------------------------------------------------ logica pura -- */

const COMPLETE_STATUSES = new Set(['complete', 'completa', 'completed', 'conclusa', 'finita']);

/** true per gli stati di una storia finita; vuoto o sconosciuto conta come non completa. */
export function isCompleteStatus(status: string | null | undefined): boolean {
  return COMPLETE_STATUSES.has((status ?? '').trim().toLowerCase());
}

/** Fonte da controllare per una scheda, null se non e' una fanfic AO3/EFP incompleta. */
export function updateSource(book: BookMeta): Source | null {
  if (book.kind !== 'fanfic' || isCompleteStatus(book.status)) return null;
  const keys = fanficSourceKeys(book);
  const ao3 = keys.find((key) => key.startsWith('ao3:'));
  if (ao3) return { site: 'ao3', id: ao3.slice(4) };
  const efp = keys.find((key) => key.startsWith('efp:'));
  if (efp) return { site: 'efp', id: efp.slice(4) };
  return null;
}

/** Confronta la scheda con quanto letto sul sito. Conserva «Ignora» dell'utente. */
export function buildFanficUpdate(
  book: Pick<BookMeta, 'status' | 'chapters'>,
  remote: RemoteStory,
  previous: FanficUpdate | null | undefined,
  now: string,
): FanficUpdate {
  // Scheda senza stato: e' il primo controllo affidabile, non un aggiornamento.
  // Lo stato e i capitoli del sito diventano il riferimento (vedi `baselinePatch`).
  const baseline = !(book.status ?? '').trim();
  // Senza il numero di capitoli nella scheda non si puo' dire quanti siano nuovi.
  const newChapters =
    !baseline && remote.chapters != null && book.chapters != null
      ? Math.max(0, remote.chapters - book.chapters)
      : 0;
  return {
    checkedAt: now,
    remoteChapters: remote.chapters,
    remoteTotal: remote.total,
    remoteComplete: remote.complete,
    remoteUpdated: remote.updated,
    newChapters,
    completed: !baseline && remote.complete && !isCompleteStatus(book.status),
    error: null,
    ...(previous?.dismissedChapters != null ? { dismissedChapters: previous.dismissedChapters } : {}),
  };
}

/**
 * Dati da scrivere sulla scheda al primo controllo di una storia senza stato: lo
 * stato e il numero di capitoli del sito (quello letto dall'EPUB conta spesso le
 * sezioni, non i capitoli). Non tocca i campi impostati a mano.
 */
export function baselinePatch(
  book: Pick<BookMeta, 'status' | 'chapters' | 'fieldSource'>,
  remote: RemoteStory,
  site: Source['site'],
): Partial<BookMeta> {
  if ((book.status ?? '').trim()) return {};
  const patch: Partial<BookMeta> = {};
  if (book.fieldSource?.status !== 'manual') {
    patch.status = site === 'efp'
      ? (remote.complete ? 'Completa' : 'In corso')
      : (remote.complete ? 'Complete' : 'Incomplete');
  }
  if (remote.chapters != null && book.fieldSource?.chapters !== 'manual') patch.chapters = remote.chapters;
  return patch;
}

/** Controllo fallito: restano i dati dell'ultimo controllo riuscito, con il motivo. */
export function buildFanficError(
  previous: FanficUpdate | null | undefined,
  message: string,
  now: string,
): FanficUpdate {
  return {
    remoteChapters: null,
    remoteTotal: null,
    remoteComplete: false,
    remoteUpdated: null,
    newChapters: 0,
    completed: false,
    ...previous,
    checkedAt: now,
    error: message,
  };
}

/** Millisecondi da `now` alla prossima esecuzione giornaliera, all'ora locale indicata. */
export function msUntilNextRun(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Attesa prima del giro all'avvio: null se l'ultimo giro e' recente (meno di 24 ore). */
export function startupDelayMs(lastRunAt: string | null, now: number): number | null {
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  if (Number.isFinite(last) && now - last <= STALE_AFTER_MS) return null;
  return STARTUP_DELAY_MS;
}

/* --------------------------------------------------------------- AO3 -- */

function ao3PageProblem(html: string): string {
  // Pagina d'errore di Cloudflare (525 «SSL handshake failed» e simili): temporanea.
  if (/cf-error-details|<title>[^<]*\b5\d\d\b/i.test(html)) {
    return 'AO3 non raggiungibile in questo momento (errore temporaneo)';
  }
  if (/just a moment|cf-browser-verification|challenge-platform/i.test(html)) {
    return 'AO3 ha bloccato la richiesta';
  }
  if (/registered users|users\/login|restricted=true|Please log in/i.test(html)) {
    // Con una sessione che AO3 non accetta piu' serve un nuovo accesso.
    if (ao3SessionActive()) {
      markAo3SessionExpired();
      return 'Accedi di nuovo ad AO3 nelle Impostazioni';
    }
    return 'L\'opera è riservata agli utenti AO3: accedi nelle Impostazioni';
  }
  if (/This work could have adult content/i.test(html)) {
    return 'AO3 richiede la conferma per i contenuti adulti';
  }
  return 'AO3 ha restituito una pagina inattesa';
}

function isNotFound(error: unknown): boolean {
  return (
    (error instanceof Ao3HttpError && error.status === 404) ||
    /non trova la pagina|non trova il file|Opera non trovata/i.test((error as Error).message)
  );
}

function isRateLimit(error: unknown): boolean {
  return (
    (error instanceof Ao3HttpError && (error.status === 429 || error.status === 503)) ||
    /troppe richieste|HTTP (429|503)/i.test((error as Error).message)
  );
}

async function readAo3(id: string): Promise<RemoteStory> {
  let html: string;
  try {
    html = await deps.fetchAo3Page(`${AO3_WORK}/${id}?view_adult=true`, deps.timeoutMs);
  } catch (error) {
    if (isNotFound(error)) throw new Error('Opera non piu\' disponibile');
    throw error;
  }
  const progress = parseAo3Progress(html);
  if (!progress) throw new Error(ao3PageProblem(html));
  return {
    chapters: progress.chapters,
    total: progress.total,
    complete: progress.complete,
    updated: progress.updated,
  };
}

async function readEfp(id: string): Promise<RemoteStory> {
  const story = await deps.loadEfp(`${EFP_STORY}${id}`);
  return {
    chapters: story.chapters.length,
    total: null,
    complete: isCompleteStatus(story.status),
    updated: null,
  };
}

function readRemote(source: Source): Promise<RemoteStory> {
  return source.site === 'ao3' ? readAo3(source.id) : readEfp(source.id);
}

/* ------------------------------------------------------------- salvataggio -- */

/** Scrive l'esito sulla scheda: senza cambiare `dateModified` e senza ricerche online. */
async function saveUpdate(
  book: BookMeta,
  fanficUpdate: FanficUpdate | null,
  extra: Partial<BookMeta> = {},
  source: 'online' | 'file' = 'online',
  touch = false,
): Promise<BookMeta> {
  return updateBook(book.id, { ...extra, fanficUpdate }, source, {
    touch,
    // `fanficUpdate` non e' un campo modificabile dall'utente: niente provenienza.
    clearSources: ['fanficUpdate'],
  });
}

/* --------------------------------------------------------------- giro -- */

interface Candidate {
  library: LibraryInfo;
  id: string;
}

let lastRunAt: string | null = null;
let lastRunLoaded = false;
const STATE_FILE = () => path.join(DATA_DIR, 'fanfic-check.json');

async function loadLastRun(): Promise<string | null> {
  if (lastRunLoaded) return lastRunAt;
  lastRunLoaded = true;
  try {
    const parsed = JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')) as { lastRunAt?: unknown };
    if (typeof parsed.lastRunAt === 'string' && Number.isFinite(Date.parse(parsed.lastRunAt))) {
      lastRunAt = parsed.lastRunAt;
    }
  } catch {
    /* mai eseguito, o file illeggibile: come se non fosse mai partito */
  }
  return lastRunAt;
}

/** Scrittura atomica (file temporaneo + rename), come indice e impostazioni. */
async function saveLastRun(value: string): Promise<void> {
  lastRunAt = value;
  ensureDir(DATA_DIR);
  const file = STATE_FILE();
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ lastRunAt: value }, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

const state = {
  running: false,
  done: 0,
  total: 0,
  found: 0,
  errors: 0,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  stopReason: null as string | null,
};

export async function getFanficCheckState(): Promise<FanficCheckState> {
  await loadLastRun();
  return {
    ...state,
    lastRunAt,
    automatic: FANFIC_CHECK_ENABLED,
    hour: FANFIC_CHECK_HOUR,
  };
}

/** Controlla una scheda nel contesto della sua libreria. Restituisce l'esito e se AO3 ha limitato le richieste. */
async function checkOne(id: string): Promise<{ update: FanficUpdate | null; rateLimited: boolean }> {
  const book = await getBookMeta(id);
  if (!book) return { update: null, rateLimited: false };
  const source = updateSource(book);
  if (!source) return { update: null, rateLimited: false };
  const now = new Date().toISOString();
  let update: FanficUpdate;
  let extra: Partial<BookMeta> = {};
  let rateLimited = false;
  try {
    const remote = await readRemote(source);
    update = buildFanficUpdate(book, remote, book.fanficUpdate, now);
    extra = baselinePatch(book, remote, source.site);
  } catch (error) {
    rateLimited = isRateLimit(error);
    const message = rateLimited
      ? 'AO3 sta limitando le richieste: riprovo al prossimo controllo'
      : (error as Error).message;
    update = buildFanficError(book.fanficUpdate, message, now);
  }
  await saveUpdate(book, update, extra);
  return { update, rateLimited };
}

async function runCheck(libraries: LibraryInfo[]): Promise<void> {
  const candidates: Array<Candidate & { checkedAt: string }> = [];
  for (const library of libraries) {
    for (const book of await loadIndexFor(library)) {
      if (updateSource(book)) {
        candidates.push({ library, id: book.id, checkedAt: book.fanficUpdate?.checkedAt ?? '' });
      }
    }
  }
  // Le opere mai controllate, o controllate da piu' tempo, per prime: se il giro si
  // ferma, il prossimo riparte da quelle rimaste indietro.
  candidates.sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  state.total = candidates.length;

  let rateLimits = 0;
  for (const [position, candidate] of candidates.entries()) {
    if (position > 0) await deps.sleep(deps.delayMs);
    const { update, rateLimited } = await runInLibrary(candidate.library, () => checkOne(candidate.id));
    state.done += 1;
    if (update?.error) state.errors += 1;
    if (isFanficUpdateAvailable(update)) state.found += 1;

    if (!rateLimited) {
      rateLimits = 0;
      continue;
    }
    rateLimits += 1;
    if (rateLimits >= MAX_RATE_LIMITS) {
      state.stopReason = `AO3 ha limitato le richieste (${rateLimits} volte di fila): giro interrotto`;
      console.warn(`[fanfic] ${state.stopReason}`);
      break;
    }
    await deps.sleep(deps.backoffMs(rateLimits));
  }
}

/**
 * Avvia un giro di controllo in background (uno solo alla volta: se ce n'e' uno in
 * corso restituisce lo stato di quello). Le librerie sono quelle indicate.
 */
export async function startFanficCheck(libraries: LibraryInfo[]): Promise<FanficCheckState> {
  if (!state.running) {
    state.running = true;
    state.done = 0;
    state.total = 0;
    state.found = 0;
    state.errors = 0;
    state.stopReason = null;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    void runCheck(libraries)
      .catch((error) => {
        state.errors += 1;
        state.stopReason = (error as Error).message;
        console.error('[fanfic] controllo aggiornamenti fallito:', error);
      })
      .then(async () => {
        const finished = new Date().toISOString();
        state.running = false;
        state.finishedAt = finished;
        await saveLastRun(finished).catch((error) =>
          console.error('[fanfic] impossibile salvare la data del controllo:', error),
        );
      });
  }
  return getFanficCheckState();
}

/* ------------------------------------------------------ pianificazione -- */

/**
 * Giro automatico: 10 minuti dopo l'avvio se l'ultimo e' vecchio di oltre 24 ore,
 * poi ogni giorno all'ora FANFIC_CHECK_HOUR (ora locale). Copre tutte le librerie.
 */
export function scheduleFanficChecks(allLibraries: () => Promise<LibraryInfo[]>): void {
  if (!FANFIC_CHECK_ENABLED) return;
  const run = () => {
    allLibraries()
      .then((libraries) => startFanficCheck(libraries))
      .catch((error) => console.error('[fanfic] avvio del controllo non riuscito:', error));
  };
  const scheduleDaily = () => {
    setTimeout(() => {
      run();
      scheduleDaily();
    }, msUntilNextRun(new Date(), FANFIC_CHECK_HOUR)).unref();
  };
  scheduleDaily();
  void loadLastRun().then((last) => {
    const delay = startupDelayMs(last, Date.now());
    if (delay !== null) setTimeout(run, delay).unref();
  });
}

/* --------------------------------------------------------- aggiornamento -- */

function backupName(existing: Set<string>, name: string): string {
  if (!existing.has(name)) return name;
  const ext = path.extname(name);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${path.basename(name, ext)} (${stamp})${ext}`;
}

async function updateFromAo3(book: BookMeta, workId: string): Promise<BookMeta> {
  if (!book.sourceFile || book.format !== 'epub') {
    throw new Error('La scheda non ha un file EPUB da aggiornare');
  }
  const settings = await loadSettings();
  const folder = path.join(settings.libraryRoot, book.folder);
  const sourcePath = path.join(folder, book.sourceFile);
  const tmp = path.join(folder, `.aggiornamento-${process.pid}-${Date.now()}.epub`);
  try {
    await deps.downloadAo3(`${AO3_DOWNLOADS}/${workId}/work.epub`, tmp, DOWNLOAD_TIMEOUT_MS);
    // Un EPUB e' uno zip: se non comincia con «PK» AO3 ha risposto con una pagina d'errore.
    const handle = await fsp.open(tmp, 'r');
    const signature = Buffer.alloc(2);
    try {
      await handle.read(signature, 0, 2, 0);
    } finally {
      await handle.close();
    }
    if (signature.toString('latin1') !== 'PK') {
      throw new Error('AO3 non ha restituito un EPUB valido');
    }
    const info = await extractInfo(tmp);
    const built = buildMetaFromInfo(info, book.sourceFile);

    // L'EPUB vecchio resta in `.backup/` (accanto all'originale, se c'e' gia').
    const backupDir = path.join(folder, '.backup');
    await fsp.mkdir(backupDir, { recursive: true });
    const taken = new Set(await fsp.readdir(backupDir));
    await fsp.copyFile(sourcePath, path.join(backupDir, backupName(taken, path.basename(sourcePath))));
    await fsp.rename(tmp, sourcePath);

    // Dal file nuovo solo conteggi e stato: titolo, tag e descrizione restano quelli
    // della scheda, che l'utente potrebbe aver corretto.
    const patch: Partial<BookMeta> = {};
    if (built.chapters != null) patch.chapters = built.chapters;
    if (built.wordCount) patch.wordCount = built.wordCount;
    if (built.status) patch.status = built.status;
    if (info.cover && !book.coverFile) {
      const ext = info.cover.ext === '.jpeg' ? '.jpg' : info.cover.ext;
      await fsp.writeFile(path.join(folder, `cover${ext}`), info.cover.data);
      patch.coverFile = `cover${ext}`;
    }

    const merged = { ...book, ...patch };
    const remote: RemoteStory = {
      chapters: merged.chapters,
      total: book.fanficUpdate?.remoteTotal ?? null,
      complete: isCompleteStatus(merged.status),
      updated: book.fanficUpdate?.remoteUpdated ?? null,
    };
    const checked = buildFanficUpdate({ status: merged.status, chapters: merged.chapters }, remote, null, new Date().toISOString());
    return await saveUpdate(book, checked, patch, 'file', true);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function updateFromEfp(book: BookMeta): Promise<BookMeta> {
  const source = updateSource({ ...book, status: '' });
  const url = book.efpUrl || (source ? `${EFP_STORY}${source.id}` : '');
  const result = await importEfpStory(url, {
    mode: 'update',
    load: deps.loadEfp,
  });
  if ('duplicate' in result) throw new Error('Non c\'è una storia EFP da aggiornare.');
  const story = result.story;
  const current = (await getBookMeta(result.book.id)) ?? result.book;
  const remote: RemoteStory = {
    chapters: story.chapters.length,
    total: null,
    complete: isCompleteStatus(story.status),
    updated: null,
  };
  const checked = buildFanficUpdate(current, remote, null, new Date().toISOString());
  return saveUpdate(current, checked);
}

/** Aggiorna la storia di una scheda dalla sua fonte (AO3: nuovo EPUB; EFP: nuova importazione). */
export async function updateFanficStory(id: string): Promise<BookMeta> {
  const book = await getBookMeta(id);
  if (!book) throw new Error('Libro non trovato');
  if (book.kind !== 'fanfic') throw new Error('Solo le fanfiction si aggiornano dal sito');
  // Anche una storia gia' segnata come completa si puo' aggiornare a mano.
  const source = updateSource({ ...book, status: '' });
  if (!source) throw new Error('La scheda non ha un link AO3 o EFP');
  return source.site === 'ao3' ? updateFromAo3(book, source.id) : updateFromEfp(book);
}

/** «Ignora»: l'avviso resta nascosto finche' non arrivano altri capitoli. */
export async function dismissFanficUpdate(id: string): Promise<BookMeta> {
  const book = await getBookMeta(id);
  if (!book) throw new Error('Libro non trovato');
  if (!book.fanficUpdate) throw new Error('Nessun aggiornamento da ignorare');
  return saveUpdate(book, { ...book.fanficUpdate, dismissedChapters: book.fanficUpdate.remoteChapters });
}
