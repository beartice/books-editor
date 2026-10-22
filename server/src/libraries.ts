import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DATA_DIR, LIBRARIES_ROOT, ensureDir } from './config.js';
import { dropIndexCache, loadIndexFor, loadSettings, peekSettings, saveGlobalSettings } from './store.js';
import { dropSeriesCache } from './seriesCache.js';
import type { LibrarySummary } from '../../shared/types.js';

/*
 * Librerie multiple. La principale e' quella di sempre: cartella
 * `settings.libraryRoot`, indice e cache in DATA_DIR, nessuna voce nel registro.
 * Le altre stanno in sottocartelle di LIBRARIES_ROOT, con indice e cache in
 * DATA_DIR/libraries/<id>/. Account, chiavi API e impostazioni tecniche sono comuni.
 */

export const MAIN_LIBRARY_ID = 'main';
const REGISTRY_FILE = path.join(DATA_DIR, 'libraries.json');
const LIBRARY_DATA_DIR = path.join(DATA_DIR, 'libraries');
const MAX_NAME_LENGTH = 80;

export interface LibraryInfo {
  id: string;
  name: string;
  /** Cartella dei libri. */
  root: string;
  /** Cartella di indice e cache delle serie. */
  dataDir: string;
  isMain: boolean;
}

interface RegistryEntry {
  id: string;
  name: string;
  /** Nome della sottocartella in LIBRARIES_ROOT. */
  folder: string;
  createdAt: string;
}

interface RegistryFile {
  version: 1;
  libraries: RegistryEntry[];
}

/** Errore con il codice HTTP da restituire al client. */
export class LibraryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------- contesto -- */

const storage = new AsyncLocalStorage<LibraryInfo>();

function mainLibrary(): LibraryInfo {
  const settings = peekSettings();
  return {
    id: MAIN_LIBRARY_ID,
    name: settings.libraryName,
    root: settings.libraryRoot,
    dataDir: DATA_DIR,
    isMain: true,
  };
}

/** Libreria della richiesta in corso; la principale se non c'e' nessun contesto. */
export function currentLibrary(): LibraryInfo {
  const context = storage.getStore();
  // Cartella e nome della principale possono cambiare dalle impostazioni: si rileggono sempre.
  if (!context || context.isMain) return mainLibrary();
  return context;
}

/** Esegue `fn` nel contesto della libreria indicata (anche i suoi lavori asincroni). */
export function runInLibrary<T>(library: LibraryInfo, fn: () => T): T {
  return storage.run(library, fn);
}

/* -------------------------------------------------------------- registro -- */

let registryCache: RegistryEntry[] | null = null;
let registryChain: Promise<unknown> = Promise.resolve();

/** Serializza le operazioni che modificano il registro (crea, rinomina, elimina). */
function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = registryChain.then(fn, fn);
  registryChain = next.catch(() => undefined);
  return next;
}

function validEntry(entry: unknown): entry is RegistryEntry {
  if (!entry || typeof entry !== 'object') return false;
  const { id, name, folder } = entry as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    /^[A-Za-z0-9-]{8,64}$/.test(id) &&
    id !== MAIN_LIBRARY_ID &&
    typeof name === 'string' &&
    typeof folder === 'string' &&
    folder !== '' &&
    folder !== '.' &&
    folder !== '..' &&
    !/[\\/]/.test(folder)
  );
}

async function loadRegistry(): Promise<RegistryEntry[]> {
  if (registryCache) return registryCache;
  try {
    const parsed = JSON.parse(await fsp.readFile(REGISTRY_FILE, 'utf8')) as Partial<RegistryFile>;
    registryCache = Array.isArray(parsed.libraries) ? parsed.libraries.filter(validEntry) : [];
  } catch {
    registryCache = [];
  }
  return registryCache;
}

/** Scrittura atomica: file temporaneo + rename, come per l'indice. */
async function saveRegistry(entries: RegistryEntry[]): Promise<void> {
  ensureDir(path.dirname(REGISTRY_FILE));
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  const payload: RegistryFile = { version: 1, libraries: entries };
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, REGISTRY_FILE);
  registryCache = entries;
}

function toInfo(entry: RegistryEntry): LibraryInfo {
  return {
    id: entry.id,
    name: entry.name,
    root: path.join(LIBRARIES_ROOT, entry.folder),
    dataDir: path.join(LIBRARY_DATA_DIR, entry.id),
    isMain: false,
  };
}

/** Libreria con l'id indicato (`main` compresa), oppure null se non esiste. */
export async function getLibrary(id: string): Promise<LibraryInfo | null> {
  await loadSettings();
  if (id === MAIN_LIBRARY_ID) return mainLibrary();
  const entry = (await loadRegistry()).find((item) => item.id === id);
  return entry ? toInfo(entry) : null;
}

/** Tutte le librerie: la principale per prima, poi quelle del registro. */
export async function allLibraries(): Promise<LibraryInfo[]> {
  await loadSettings();
  return [mainLibrary(), ...(await loadRegistry()).map(toInfo)];
}

export async function listLibraries(): Promise<LibrarySummary[]> {
  const libraries = await allLibraries();
  return Promise.all(
    libraries.map(async (library) => ({
      id: library.id,
      name: library.name,
      bookCount: (await loadIndexFor(library)).length,
      isMain: library.isMain,
    })),
  );
}

/* ------------------------------------------------------------------ nomi -- */

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new LibraryError(400, 'Il nome della libreria e\' obbligatorio');
  if (name.length > MAX_NAME_LENGTH) {
    throw new LibraryError(400, `Il nome della libreria puo' avere al massimo ${MAX_NAME_LENGTH} caratteri`);
  }
  return name;
}

/** Il nome deve essere unico, senza distinzione di maiuscole (`exceptId` = la libreria che si rinomina). */
async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const wanted = name.toLowerCase();
  const taken = (await allLibraries()).some(
    (library) => library.id !== exceptId && library.name.trim().toLowerCase() === wanted,
  );
  if (taken) throw new LibraryError(409, `Esiste gia' una libreria chiamata «${name}»`);
}

/** Nome di cartella sicuro ricavato dal nome della libreria. */
function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'libreria';
}

/* ---------------------------------------------------------- cartelle ------ */

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realOrSame(target: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch {
    return target;
  }
}

/** true se `target` coincide con `parent` o sta al suo interno (anche attraverso link simbolici). */
export async function isInsideFolder(parent: string, target: string): Promise<boolean> {
  return (
    isInside(path.resolve(parent), path.resolve(target)) ||
    isInside(await realOrSame(parent), await realOrSame(target))
  );
}

/** Controlla che LIBRARIES_ROOT non si sovrapponga ai dati dell'app o alla libreria principale. */
export async function assertLibrariesRootUsable(): Promise<void> {
  await loadSettings();
  const main = mainLibrary().root;
  const clash = (a: string, b: string) => isInside(a, b) || isInside(b, a);
  const bad =
    clash(LIBRARIES_ROOT, DATA_DIR) ||
    clash(LIBRARIES_ROOT, main) ||
    clash(await realOrSame(LIBRARIES_ROOT), await realOrSame(DATA_DIR)) ||
    clash(await realOrSame(LIBRARIES_ROOT), await realOrSame(main));
  if (bad) {
    throw new LibraryError(
      500,
      'La cartella delle librerie (LIBRARIES_ROOT) non puo\' coincidere con la libreria principale o con la cartella dei dati, ne\' contenerle o starci dentro',
    );
  }
}

/** Percorsi di tutte le librerie: servono a rifiutare l'import da dentro una libreria qualunque. */
export async function allLibraryRoots(): Promise<Array<{ id: string; name: string; root: string }>> {
  return (await allLibraries()).map(({ id, name, root }) => ({ id, name, root }));
}

/* --------------------------------------------------------------- crea ... -- */

export async function createLibrary(rawName: unknown): Promise<LibrarySummary> {
  const name = cleanName(rawName);
  return withRegistryLock(async () => {
    await assertNameFree(name);
    await assertLibrariesRootUsable();
    const entries = await loadRegistry();

    // Cartella libera: sia fra quelle del registro sia sul disco.
    const slug = slugify(name);
    let folder = slug;
    for (let counter = 2; ; counter += 1) {
      const used =
        entries.some((entry) => entry.folder.toLowerCase() === folder.toLowerCase()) ||
        (await fsp.stat(path.join(LIBRARIES_ROOT, folder)).then(() => true, () => false));
      if (!used) break;
      folder = `${slug}-${counter}`;
    }

    const entry: RegistryEntry = {
      id: crypto.randomUUID(),
      name,
      folder,
      createdAt: new Date().toISOString(),
    };
    const root = path.join(LIBRARIES_ROOT, folder);
    try {
      await fsp.mkdir(root, { recursive: true });
      // Prova di scrittura, come per la cartella della libreria principale.
      const probe = path.join(root, `.write-test-${crypto.randomBytes(6).toString('hex')}`);
      await fsp.writeFile(probe, '');
      await fsp.rm(probe, { force: true });
      await saveRegistry([...entries, entry]);
    } catch (error) {
      await fsp.rmdir(root).catch(() => undefined);
      if (error instanceof LibraryError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new LibraryError(500, `Impossibile creare la cartella della libreria: ${code ?? (error as Error).message}`);
    }
    return { id: entry.id, name, bookCount: 0, isMain: false };
  });
}

export async function renameLibrary(id: string, rawName: unknown): Promise<LibrarySummary> {
  const name = cleanName(rawName);
  return withRegistryLock(async () => {
    const library = await getLibrary(id);
    if (!library) throw new LibraryError(404, 'Libreria inesistente');
    await assertNameFree(name, id);
    if (library.isMain) {
      await saveGlobalSettings({ libraryName: name });
    } else {
      const entries = await loadRegistry();
      await saveRegistry(entries.map((entry) => (entry.id === id ? { ...entry, name } : entry)));
    }
    return {
      id,
      name,
      bookCount: (await loadIndexFor(library)).length,
      isMain: library.isMain,
    };
  });
}

/**
 * Elimina una libreria, ma solo se e' vuota: nessun libro nell'indice (dopo una
 * scansione) e nessuna cartella di libro sul disco. La cartella si toglie con
 * rmdir, quindi non porta mai via file.
 */
export async function deleteLibrary(id: string): Promise<void> {
  if (id === MAIN_LIBRARY_ID) throw new LibraryError(400, 'La libreria principale non si puo\' eliminare');
  return withRegistryLock(async () => {
    const library = await getLibrary(id);
    if (!library) throw new LibraryError(404, 'Libreria inesistente');

    // Scansione: porta l'indice in linea con il disco prima di decidere.
    await fsp.mkdir(library.root, { recursive: true });
    const { scanLibrary } = await import('./library.js');
    await runInLibrary(library, () => scanLibrary());
    const count = (await loadIndexFor(library)).length;
    if (count > 0) {
      throw new LibraryError(
        409,
        `La libreria contiene ancora ${count} ${count === 1 ? 'opera' : 'opere'}: spostale o eliminale prima`,
      );
    }

    // Residui nostri (cartella di appoggio degli upload, .DS_Store): solo se vuoti o inutili.
    await fsp.rmdir(path.join(library.root, '.uploads')).catch(() => undefined);
    await fsp.rm(path.join(library.root, '.DS_Store'), { force: true });
    try {
      await fsp.rmdir(library.root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw new LibraryError(409, 'La cartella della libreria contiene ancora dei file: controllala prima di eliminarla');
      }
      if (code !== 'ENOENT') {
        throw new LibraryError(500, `Impossibile eliminare la cartella della libreria: ${code ?? (error as Error).message}`);
      }
    }

    await saveRegistry((await loadRegistry()).filter((entry) => entry.id !== id));
    dropIndexCache(id);
    dropSeriesCache(id);
    // Indice e cache della libreria: sono nostri e stanno sempre in DATA_DIR/libraries/<id>.
    if (isInside(LIBRARY_DATA_DIR, library.dataDir) && library.dataDir !== LIBRARY_DATA_DIR) {
      await fsp.rm(library.dataDir, { recursive: true, force: true });
    }
  });
}

/* --------------------------------------------------- richieste (Fastify) -- */

/** Percorsi che non dipendono dalla libreria: restano sulla principale e non vanno in errore. */
function isLibraryIndependent(url: string): boolean {
  return url === '/api/health' || url.startsWith('/api/auth/');
}

/** Id della libreria richiesta: header `X-Library`, oppure query `lib` (per <img> e link di download). */
function requestedLibraryId(request: FastifyRequest): string {
  const header = request.headers['x-library'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader && fromHeader.trim()) return fromHeader.trim();
  const query = (request.query as Record<string, unknown> | undefined)?.lib;
  const fromQuery = Array.isArray(query) ? query[0] : query;
  return typeof fromQuery === 'string' && fromQuery.trim() ? fromQuery.trim() : MAIN_LIBRARY_ID;
}

/**
 * Collega ogni richiesta alla sua libreria. Va registrato dopo l'autenticazione.
 * La libreria si risolve in `onRequest` (404 se l'id non esiste); il contesto
 * si apre in `preHandler` con `AsyncLocalStorage.run`, subito prima dell'handler:
 * lui e tutto cio' che avvia (compresi i lavori in background, come l'import da
 * Jellyfin) lo ereditano, senza dipendere da cosa fa il parser del corpo.
 */
export function registerLibraryContext(app: FastifyInstance): void {
  const resolved = new WeakMap<FastifyRequest, LibraryInfo>();

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions?.url ?? '';
    if (!route.startsWith('/api/') || isLibraryIndependent(route)) return;
    const library = await getLibrary(requestedLibraryId(request));
    if (!library) return reply.code(404).send({ error: 'Libreria inesistente' });
    resolved.set(request, library);
  });

  app.addHook('preHandler', (request, _reply, done) => {
    const library = resolved.get(request);
    if (library) storage.run(library, done);
    else done();
  });
}
