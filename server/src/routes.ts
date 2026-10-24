import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  DATA_DIR,
  DEFAULT_LIBRARY_ROOT,
  IMPORT_ROOTS,
  IS_PRODUCTION,
  LIBRARY_ROOT_LOCKED,
  MAX_UPLOAD_MB,
  ensureDir,
} from './config.js';
import { prepareLibraryRoot } from './libraryRoot.js';
import {
  LibraryError,
  allLibraries,
  allLibraryRoots,
  createLibrary,
  currentLibrary,
  deleteLibrary,
  isInsideFolder,
  listLibraries,
  renameLibrary,
  setLibraryHideFanfics,
  visibleBooks,
} from './libraries.js';
import { moveBookToLibrary } from './libraryMove.js';
import { notifyBook } from './bookEvents.js';
import { conversionSupport } from './convert.js';
import { loadIndex, loadSettings, saveIndex, saveSettings, toSummary } from './store.js';
import {
  applyCandidate,
  attachEdition,
  downloadCoverToFolder,
  editionSuggestions,
  emptyMeta,
  extractCoverFromFile,
  findDuplicate,
  findIdenticalFile,
  getBookMeta,
  getBookRecord,
  importPath,
  listBooks,
  prepareImport,
  mergeBooks,
  refreshFromFile,
  removeCover,
  removeEdition,
  scanLibrary,
  setCover,
  updateBook,
  writeBookJsonPublic,
} from './library.js';
import { lookupFanficPage, lookupGoogleVolume, lookupOnline } from './providers/index.js';
import { getCoverThumbnail, removeCoverThumbnails } from './thumbnails.js';
import { lookupSeries, readCachedSeries } from './providers/series.js';
import { readSeriesTotals, writeSeriesTotal } from './seriesCache.js';
import { computeReadingStats, localDay } from './readingStats.js';
import { compareLocations, importAppleBooks, importAppleBooksFromRows, syncAppleBooksForBooks } from './appleBooks.js';
import { AppleBooksInputError, parseAppleBooksInput } from './appleBooksInput.js';
import { buildEpubWithMetadata, writeEpubMetadata } from './epubWrite.js';
import { AppleBooksError, appleBooksStatus, writeToAppleBooks, type AppleBooksField } from './appleBooksWrite.js';
import { Ao3LoginError, loginAo3 } from './ao3login.js';
import { ao3SessionInfo, clearAo3Session } from './providers/ao3session.js';
import { buildEpub, buildOdt, importEfpStory, loadEfpStory } from './efp.js';
import {
  dismissFanficUpdate,
  getFanficCheckState,
  startFanficCheck,
  updateFanficStory,
} from './fanficUpdates.js';
import { getJellyfinInfo, listJellyfinLibraries } from './jellyfin.js';
import { getJellyfinSyncState, pushBookNow, startJellyfinSync } from './jellyfinSync.js';
import type { DuplicateMatch, PreparedImport } from './library.js';
import { HIGHLIGHT_COLORS, READING_STATUSES } from '../../shared/types.js';
import type { AppSettings, BookHighlight, BookMeta, HighlightColor, MetadataCandidate, ReadingStatus } from '../../shared/types.js';

const COVER_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const FILE_MIME: Record<string, string> = {
  '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.mobi': 'application/x-mobipocket-ebook',
  '.azw3': 'application/vnd.amazon.ebook',
  '.azw': 'application/vnd.amazon.ebook',
  '.prc': 'application/x-mobipocket-ebook',
  '.fb2': 'application/x-fictionbook+xml',
  '.djvu': 'image/vnd.djvu',
  '.djv': 'image/vnd.djvu',
};

/** Content-Disposition per un download (o `inline`), con fallback ASCII per i browser vecchi. */
function attachmentHeader(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Nome del file scaricato: per il file principale "Autore - Titolo.ext" (i file
 * caricati dal browser hanno un prefisso numerico), per gli extra il nome reale.
 * Se la scheda ha piu' lingue, ogni file porta il suo titolo e il codice lingua,
 * es. "Autore - Titolo (IT).epub".
 */
function downloadName(book: BookMeta, file: string): string {
  const edition = (book.editions ?? []).find((item) => item.file === file);
  const isMain = file === book.sourceFile || file === book.originalFile;
  if (!isMain && !edition) return path.basename(file);
  const title = (edition ? edition.title : book.title).trim() || book.title.trim();
  if (!title) return path.basename(file);
  const language = (edition ? edition.language : book.language).trim().toUpperCase();
  const suffix = book.editions?.length && /^[A-Z]{2}$/.test(language) ? ` (${language})` : '';
  const base = book.authors[0] ? `${book.authors[0]} - ${title}` : title;
  const safe = `${base}${suffix}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return `${safe}${path.extname(file).toLowerCase()}`;
}

/**
 * Non espone mai la chiave API al browser: la sostituisce con un flag
 * booleano che l'interfaccia usa per mostrare "chiave configurata".
 */
/**
 * Controlla che «Importa da percorso» possa leggere il percorso indicato.
 * Con IMPORT_ROOTS risolve i symlink e richiede che sia dentro una radice;
 * in produzione senza IMPORT_ROOTS la funzione e' disattivata.
 * Ritorna il percorso da usare, oppure il messaggio d'errore (403).
 */
async function guardImportPath(target: string): Promise<{ path: string } | { error: string }> {
  if (IMPORT_ROOTS.length === 0) {
    if (IS_PRODUCTION) {
      return { error: 'L\'importazione da percorso del server e\' disattivata' };
    }
    return { path: target };
  }
  let real: string;
  try {
    real = await fsp.realpath(path.resolve(target));
  } catch {
    return { error: 'Percorso non consentito o inesistente' };
  }
  for (const root of IMPORT_ROOTS) {
    const realRoot = await fsp.realpath(root).catch(() => root);
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return { path: real };
  }
  return { error: 'Percorso non consentito: fuori dalle cartelle di importazione autorizzate' };
}

function publicSettings(settings: AppSettings): AppSettings {
  const { googleBooksApiKey, jellyfinApiKey, ...rest } = settings;
  return {
    ...rest,
    // Fuori dalla principale la cartella la decide il server (LIBRARIES_ROOT).
    libraryRootLocked: LIBRARY_ROOT_LOCKED || !currentLibrary().isMain,
    maxUploadMb: MAX_UPLOAD_MB,
    jellyfinApiKeySet: Boolean(jellyfinApiKey?.trim()),
    googleBooksApiKeySet: Boolean(googleBooksApiKey?.trim()),
    googleBooksApiKeyEnvSet: Boolean(process.env.GOOGLE_BOOKS_API_KEY?.trim()),
  };
}

function statsFor(books: BookMeta[]) {
  let words = 0;
  let withCover = 0;
  let missingMetadata = 0;
  const byFormat: Record<string, number> = {};
  let books_ = 0;
  let fanfics = 0;

  for (const book of books) {
    words += book.wordCount ?? 0;
    if (book.coverFile) withCover += 1;
    if (book.kind === 'fanfic') fanfics += 1;
    else books_ += 1;
    byFormat[book.format] = (byFormat[book.format] ?? 0) + 1;
    if (!book.authors.length || !book.title) missingMetadata += 1;
  }

  return {
    total: books.length,
    books: books_,
    fanfics,
    words,
    withCover,
    missingMetadata,
    byFormat,
  };
}

/** Risposta 409 per un'opera gia' presente (con i dati della lingua, se e' un'altra lingua). */
function duplicateReply(duplicate: DuplicateMatch) {
  return {
    error: 'Opera gia\' presente nella libreria',
    duplicate: {
      reason: duplicate.reason,
      book: toSummary(duplicate.book),
      ...(duplicate.reason === 'language'
        ? { language: duplicate.language, existingLanguages: duplicate.existingLanguages }
        : {}),
    },
  };
}

/** Prepara il percorso temporaneo in `.uploads` per un file caricato dal browser. */
async function stagingPath(filename: string | undefined): Promise<string> {
  const settings = await loadSettings();
  const staging = path.join(settings.libraryRoot, '.uploads');
  await fsp.mkdir(staging, { recursive: true });
  const safeName = path.basename(filename ?? 'opera').replace(/[\\/:*?"<>|]/g, '-');
  return path.join(staging, `${Date.now()}-${safeName}`);
}

/** Errore di upload oltre il limite `MAX_UPLOAD_MB`. */
class UploadTooLargeError extends Error {
  constructor() {
    super(`File troppo grande: il limite e' ${MAX_UPLOAD_MB} MB`);
  }
}

/**
 * Salva un file caricato in `.uploads` e ne restituisce il percorso: scrive il flusso su disco senza tenerlo in memoria.
 * Se il file supera il limite cancella il temporaneo e lancia `UploadTooLargeError`.
 */
async function stageUploadStream(
  filename: string | undefined,
  stream: Readable & { truncated?: boolean },
): Promise<string> {
  const tempPath = await stagingPath(filename);
  try {
    await pipeline(stream, fs.createWriteStream(tempPath));
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new UploadTooLargeError();
    throw error;
  }
  if (stream.truncated) {
    await fsp.rm(tempPath, { force: true });
    throw new UploadTooLargeError();
  }
  return tempPath;
}

/** Salva l'upload in streaming; in caso di errore risponde (413 se troppo grande) e ritorna null. */
async function stageUploadOrReply(
  reply: FastifyReply,
  filename: string | undefined,
  stream: Readable & { truncated?: boolean },
): Promise<string | null> {
  try {
    return await stageUploadStream(filename, stream);
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      await reply.code(413).send({ error: error.message });
      return null;
    }
    await reply.code(400).send({ error: (error as Error).message });
    return null;
  }
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, version: '1.0.0' }));

  /** Formati che il server sa convertire in EPUB/PDF all'import (dipende dagli strumenti installati). */
  app.get('/api/conversion', async () => conversionSupport());

  /* ------------------------------------------------------------ librerie -- */
  const libraryFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof LibraryError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };

  app.get('/api/libraries', async () => listLibraries());

  app.post<{ Body: { name?: string } }>('/api/libraries', async (request, reply) => {
    try {
      return await createLibrary(request.body?.name);
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; hideFanfics?: boolean } }>('/api/libraries/:id', async (request, reply) => {
    try {
      const { name, hideFanfics } = request.body ?? {};
      if (name === undefined && hideFanfics === undefined) {
        throw new LibraryError(400, 'Nessuna modifica richiesta');
      }
      // Se arrivano entrambi, prima si controlla tutto: il nome puo' fallire (409) e non si applica mezza richiesta.
      if (hideFanfics !== undefined && typeof hideFanfics !== 'boolean') {
        throw new LibraryError(400, 'Il valore di «Mostra le fanfiction» deve essere si\' o no');
      }
      let summary;
      if (name !== undefined) summary = await renameLibrary(request.params.id, name);
      if (hideFanfics !== undefined) summary = await setLibraryHideFanfics(request.params.id, hideFanfics);
      return summary;
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/libraries/:id', async (request, reply) => {
    try {
      await deleteLibrary(request.params.id);
      return { ok: true };
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  /* ------------------------------------------------------- impostazioni -- */
  app.get('/api/settings', async () => publicSettings(await loadSettings()));

  app.put<{ Body: Partial<AppSettings> }>('/api/settings', async (request, reply) => {
    const patch = { ...request.body };
    delete patch.googleBooksApiKeySet;
    delete patch.googleBooksApiKeyEnvSet;
    delete patch.jellyfinApiKeySet;
    if (typeof patch.jellyfinApiKey === 'string') {
      patch.jellyfinApiKey = patch.jellyfinApiKey.trim();
    } else {
      delete patch.jellyfinApiKey;
    }
    if (typeof patch.jellyfinUrl === 'string') {
      let url = patch.jellyfinUrl.trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/i.test(url)) {
        return reply.code(400).send({
          error: 'Indirizzo Jellyfin non valido: deve iniziare con http:// o https://',
        });
      }
      patch.jellyfinUrl = url;
    } else {
      delete patch.jellyfinUrl;
    }
    if (typeof patch.jellyfinBooksLibraryId === 'string') {
      patch.jellyfinBooksLibraryId = patch.jellyfinBooksLibraryId.trim();
    } else {
      delete patch.jellyfinBooksLibraryId;
    }
    if (typeof patch.jellyfinPushEnabled !== 'boolean') delete patch.jellyfinPushEnabled;
    if (typeof patch.googleBooksApiKey === 'string') {
      patch.googleBooksApiKey = patch.googleBooksApiKey.trim();
    } else {
      delete patch.googleBooksApiKey;
    }
    delete patch.libraryRootLocked;
    // Si cambia solo da PATCH /api/libraries/main.
    delete patch.mainHideFanfics;
    const library = currentLibrary();
    let renamedTo: string | undefined;
    if (!library.isMain) {
      // Cartella e nome sono della libreria aperta, non del file globale.
      if (patch.libraryRoot !== undefined) {
        // Il client rimanda il valore invariato: va bene, e' solo un cambio a essere rifiutato.
        if (path.resolve(String(patch.libraryRoot)) !== path.resolve(library.root)) {
          return reply.code(400).send({
            error: 'La cartella di questa libreria non si puo\' cambiare: sta nella cartella delle librerie del server',
          });
        }
        delete patch.libraryRoot;
      }
      if (patch.libraryName !== undefined) {
        const newName = typeof patch.libraryName === 'string' ? patch.libraryName.trim() : '';
        delete patch.libraryName;
        if (newName !== library.name) {
          try {
            renamedTo = (await renameLibrary(library.id, newName)).name;
          } catch (error) {
            if (error instanceof LibraryError) return reply.code(error.status).send({ error: error.message });
            throw error;
          }
        }
      }
    } else if (LIBRARY_ROOT_LOCKED && patch.libraryRoot !== undefined) {
      // Il client rimanda il valore invariato: va bene, e' solo un cambio a essere rifiutato.
      if (path.resolve(String(patch.libraryRoot)) !== path.resolve(DEFAULT_LIBRARY_ROOT)) {
        return reply.code(400).send({
          error: 'La cartella della libreria e\' bloccata dalla variabile d\'ambiente LIBRARY_ROOT',
        });
      }
      delete patch.libraryRoot;
    }
    if (patch.libraryRoot) {
      const prepared = await prepareLibraryRoot(String(patch.libraryRoot));
      if ('error' in prepared) return reply.code(400).send({ error: prepared.error });
      patch.libraryRoot = prepared.path;
    }
    if (patch.seriesRefreshDays !== undefined) {
      const days = Math.round(Number(patch.seriesRefreshDays));
      patch.seriesRefreshDays = Number.isFinite(days)
        ? Math.min(365, Math.max(1, days))
        : 30;
    }
    const saved = await saveSettings(patch);
    return publicSettings(renamedTo ? { ...saved, libraryName: renamedTo } : saved);
  });

  /* ----------------------------------------------------------- jellyfin -- */
  app.get('/api/jellyfin/info', async (_request, reply) => {
    try {
      return await getJellyfinInfo();
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get('/api/jellyfin/libraries', async (_request, reply) => {
    try {
      return await listJellyfinLibraries();
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /** Stato dell'abbinamento e dell'invio dei metadati a Jellyfin. */
  app.get('/api/jellyfin/sync/status', async () => getJellyfinSyncState());

  /** «Aggiorna Jellyfin ora»: abbina e invia in background (`force` rimanda anche le schede invariate). */
  app.post<{ Body: { force?: boolean } | undefined }>('/api/jellyfin/sync', async (request, reply) => {
    try {
      return await startJellyfinSync({ force: request.body?.force === true });
    } catch (error) {
      return reply.code((error as Error).message.includes('in corso') ? 409 : 400).send({ error: (error as Error).message });
    }
  });

  /** Invia subito a Jellyfin i metadati di una scheda. */
  app.post<{ Params: { id: string } }>('/api/books/:id/jellyfin-push', async (request, reply) => {
    try {
      return await pushBookNow(request.params.id);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /* ------------------------------------------------------------- libri -- */
  app.get('/api/books', async () => {
    const books = await listBooks();
    // Le statistiche contano le stesse opere dell'elenco: senza le fanfiction nascoste.
    const visible = visibleBooks(currentLibrary(), await loadIndex());
    return { books, stats: statsFor(visible) };
  });

  app.get<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    const book = await getBookMeta(request.params.id);
    if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
    return book;
  });

  app.patch<{ Params: { id: string }; Body: Partial<BookMeta> }>(
    '/api/books/:id',
    async (request, reply) => {
      try {
        const allowed = pickAllowed(request.body);
        // Un avanzamento cambiato a mano conta come aggiornamento piu' recente di quello di Apple Books.
        if ('readingProgress' in allowed) {
          const current = await getBookMeta(request.params.id);
          if (current && (current.readingProgress ?? null) !== (allowed.readingProgress ?? null)) {
            allowed.readingProgressUpdatedAt = new Date().toISOString();
          }
        }
        const updated = await updateBook(request.params.id, allowed, 'manual');
        return updated;
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );

  /* ------------------------------------------- aggiornamenti delle fanfic -- */
  /* --------------------------------------------------------- account AO3 -- */
  /** Accesso ad AO3: la password serve solo per questa richiesta, il server conserva la sessione. */
  app.post<{ Body: { username?: string; password?: string } | undefined }>('/api/ao3/login', async (request, reply) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!username || !password) return reply.code(400).send({ error: 'Inserisci utente e password di AO3' });
    try {
      await loginAo3(username, password);
      return ao3SessionInfo();
    } catch (error) {
      if (error instanceof Ao3LoginError) return reply.code(error.status).send({ error: error.message });
      return reply.code(502).send({ error: 'Accesso ad AO3 non riuscito' });
    }
  });

  app.get('/api/ao3/session', async () => ao3SessionInfo());

  app.post('/api/ao3/logout', async () => {
    await clearAo3Session();
    return ao3SessionInfo();
  });

  /** Avvia il controllo dei nuovi capitoli (libreria aperta, o `all` per tutte). Un solo giro alla volta. */
  app.post<{ Body: { all?: boolean } | undefined }>('/api/fanfic-updates/check', async (request) => {
    const libraries = request.body?.all === true ? await allLibraries() : [currentLibrary()];
    return startFanficCheck(libraries);
  });

  app.get('/api/fanfic-updates/status', async () => getFanficCheckState());

  /** Aggiorna la storia dal sito: AO3 scarica un EPUB nuovo, EFP rifa l'importazione. */
  app.post<{ Params: { id: string } }>('/api/books/:id/fanfic-update', async (request, reply) => {
    try {
      return await updateFanficStory(request.params.id);
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message === 'Libro non trovato' ? 404 : 400).send({ error: message });
    }
  });

  /** «Ignora» l'avviso finche' non arrivano altri capitoli. */
  app.post<{ Params: { id: string } }>('/api/books/:id/fanfic-update/dismiss', async (request, reply) => {
    try {
      return await dismissFanficUpdate(request.params.id);
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message === 'Libro non trovato' ? 404 : 400).send({ error: message });
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { keepFiles?: string } }>(
    '/api/books/:id',
    async (request, reply) => {
      const record = await getBookRecord(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Libro non trovato' });
      const settings = await loadSettings();
      if (request.query.keepFiles !== '1') {
        const folderPath = path.join(settings.libraryRoot, record.meta.folder);
        await fsp.rm(folderPath, { recursive: true, force: true });
      }
      const store = await import('./store.js');
      const index = await store.loadIndex();
      await store.saveIndex(index.filter((book) => book.id !== request.params.id));
      await removeCoverThumbnails(request.params.id);
      return { ok: true };
    },
  );

  /** Sposta il libro (cartella compresa) in un'altra libreria; l'id non cambia. */
  app.post<{ Params: { id: string }; Body: { to?: string } }>('/api/books/:id/move', async (request, reply) => {
    const to = request.body?.to;
    if (typeof to !== 'string' || !to) return reply.code(400).send({ error: 'Libreria di destinazione mancante' });
    try {
      const moved = await moveBookToLibrary(request.params.id, to);
      await removeCoverThumbnails(request.params.id);
      return { ok: true, to: moved.to, book: moved.book };
    } catch (error) {
      return libraryFailure(reply, error);
    }
  });

  /**
   * Sovrascrive copertina e metadati dentro il file EPUB con quelli della scheda.
   * L'originale viene salvato una sola volta in `.backup/`.
   */
  app.post<{ Params: { id: string } }>('/api/books/:id/write-epub', async (request, reply) => {
    const record = await getBookRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: 'Libro non trovato' });
    if (record.meta.format !== 'epub' || !record.sourcePath) {
      return reply.code(400).send({ error: 'Solo i libri EPUB con un file nella cartella possono essere aggiornati' });
    }
    try {
      // Con piu' lingue si aggiorna solo il file principale: le altre edizioni restano com'erano.
      return await writeEpubMetadata(record.sourcePath, record.meta, record.coverPath);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /** Stato della scrittura su Apple Books: disponibile solo su macOS e per libri importati. */
  app.get<{ Params: { id: string } }>('/api/books/:id/applebooks', async (request, reply) => {
    const record = await getBookRecord(request.params.id);
    if (!record) return reply.code(404).send({ error: 'Libro non trovato' });
    return appleBooksStatus(record);
  });

  /** Scrive copertina, titolo e autore nella copia del libro che Apple Books ha gia'. */
  app.post<{ Params: { id: string }; Body: { fields?: string[]; quitApp?: boolean } }>(
    '/api/books/:id/applebooks',
    async (request, reply) => {
      const record = await getBookRecord(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Libro non trovato' });
      const allowed: AppleBooksField[] = ['title', 'authors', 'cover'];
      const fields = (request.body?.fields ?? []).filter((f): f is AppleBooksField =>
        (allowed as string[]).includes(f),
      );
      if (!fields.length) return reply.code(400).send({ error: 'Scegli almeno un campo da scrivere' });
      try {
        return await writeToAppleBooks(record, {
          fields,
          quitApp: request.body?.quitApp === true,
          backupsDir: path.join(DATA_DIR, 'applebooks-backups'),
        });
      } catch (error) {
        const code = error instanceof AppleBooksError && error.code === 'running' ? 409 : 400;
        return reply.code(code).send({ error: (error as Error).message });
      }
    },
  );

  /* ------------------------------------------------- lingue (edizioni) -- */
  /** Altre schede che sembrano la stessa opera in un'altra lingua. */
  app.get<{ Params: { id: string } }>(
    '/api/books/:id/edition-suggestions',
    async (request, reply) => {
      try {
        return (await editionSuggestions(request.params.id)).map(toSummary);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );

  /** Carica un file e lo aggiunge alla scheda come edizione in un'altra lingua. */
  app.post<{ Params: { id: string } }>('/api/books/:id/editions', async (request, reply) => {
    const book = await getBookMeta(request.params.id);
    if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'Nessun file ricevuto' });
    const tempPath = await stageUploadOrReply(reply, file.filename, file.file);
    if (!tempPath) return reply;
    let prepared: PreparedImport | null = null;
    try {
      // Un MOBI, AZW3, FB2... viene convertito: l'edizione e' il file convertito.
      prepared = await prepareImport(tempPath, { force: true });
      const same = await findIdenticalFile(book, prepared.path);
      if (same) {
        return reply.code(409).send({
          error: `Il file e' identico a «${same}», gia' presente nella scheda`,
          duplicate: { reason: 'file', book: toSummary(book) },
        });
      }
      return await attachEdition(book.id, prepared.path);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    } finally {
      await prepared?.cleanup();
      await fsp.rm(tempPath, { force: true });
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { file?: string } }>(
    '/api/books/:id/editions',
    async (request, reply) => {
      const file = request.query.file;
      if (!file) return reply.code(400).send({ error: 'File mancante' });
      try {
        return await removeEdition(request.params.id, file);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /** Unisce un'altra scheda a questa: i suoi file diventano altre lingue. */
  app.post<{ Params: { id: string }; Body: { otherId?: string } }>(
    '/api/books/:id/merge',
    async (request, reply) => {
      const otherId = request.body?.otherId;
      if (!otherId) return reply.code(400).send({ error: 'Scheda da unire mancante' });
      try {
        return await mergeBooks(request.params.id, otherId);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /**
   * Scarica il file principale dell'opera o uno dei suoi file extra (es. l'ODT
   * delle storie EFP). Si servono solo i file registrati nella scheda.
   */
  app.get<{ Params: { id: string }; Querystring: { file?: string; meta?: string; inline?: string } }>(
    '/api/books/:id/download',
    async (request, reply) => {
      const book = await getBookMeta(request.params.id);
      if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
      const allowed = [book.sourceFile, ...(book.extraFiles ?? []), book.originalFile].filter(
        (name): name is string => Boolean(name),
      );
      const file = request.query.file || book.sourceFile;
      if (!file || !allowed.includes(file)) {
        return reply.code(404).send({ error: 'File non disponibile per questa opera' });
      }

      const settings = await loadSettings();
      const folderPath = path.resolve(settings.libraryRoot, book.folder);
      const filePath = path.resolve(folderPath, file);
      if (path.relative(folderPath, filePath).startsWith('..')) {
        return reply.code(400).send({ error: 'Percorso non valido' });
      }
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        return reply.code(404).send({ error: `File non trovato nella cartella: ${file}` });
      }

      const mime = FILE_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      // inline=1 vale solo per EPUB e PDF (anteprima di iOS con «Apri in Libri»): mai HTML o testo inline dalla nostra origine.
      const ext = path.extname(file).toLowerCase();
      const disposition =
        request.query.inline === '1' && (ext === '.epub' || ext === '.pdf') ? 'inline' : 'attachment';

      // meta=1 (solo EPUB): copia in memoria con i metadati della scheda, il file su disco non cambia.
      if (request.query.meta === '1' && path.extname(file).toLowerCase() === '.epub') {
        const record = await getBookRecord(request.params.id);
        // Il titolo si scrive solo nel file principale: le altre edizioni sono in un'altra lingua.
        const fields = file === book.sourceFile ? ['title', 'authors', 'cover'] : ['authors', 'cover'];
        try {
          const built = await buildEpubWithMetadata(filePath, book, record?.coverPath ?? null, { fields });
          return reply
            .header('Content-Type', mime)
            .header('Content-Length', built.data.length)
            .header('Content-Disposition', attachmentHeader(downloadName(book, file), disposition))
            .header('Cache-Control', 'no-store')
            .header('X-Books-Metadata', 'card')
            .send(built.data);
        } catch (error) {
          request.log.warn({ err: error, file }, 'Metadati della scheda non scritti: si invia il file originale');
          reply.header('X-Books-Metadata', 'original');
        }
      }

      return reply
        .header('Content-Type', mime)
        .header('Content-Length', stat.size)
        .header('Content-Disposition', attachmentHeader(downloadName(book, file), disposition))
        .header('Cache-Control', 'no-store')
        .send(fs.createReadStream(filePath));
    },
  );

  /**
   * Salva la posizione di lettura del lettore integrato. E' un POST (e non un PUT)
   * perche' la chiusura della pagina la invia con `navigator.sendBeacon`.
   * Non fa partire ricerche online: aggiorna solo i campi della lettura.
   */
  app.post<{ Params: { id: string }; Body: { file?: unknown; location?: unknown; progress?: unknown } }>(
    '/api/books/:id/reading-position',
    async (request, reply) => {
      const book = await getBookMeta(request.params.id);
      if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
      const { file, location, progress } = request.body ?? {};
      const readable = [book.sourceFile, ...(book.editions ?? []).map((edition) => edition.file)].filter(
        (name): name is string => Boolean(name),
      );
      if (typeof file !== 'string' || !readable.includes(file) || !/\.(epub|pdf)$/i.test(file)) {
        return reply.code(400).send({ error: 'File non leggibile nel lettore' });
      }
      if (typeof location !== 'string' || !location || location.length > 1000) {
        return reply.code(400).send({ error: 'Posizione non valida' });
      }
      if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) {
        return reply.code(400).send({ error: 'Avanzamento non valido (0-100)' });
      }
      const now = new Date().toISOString();
      const patch: Partial<BookMeta> = {
        readingPositions: { ...book.readingPositions, [file]: { location, progress, updatedAt: now } },
        readingProgress: Math.round(progress),
        readingProgressUpdatedAt: now,
      };
      // Il lettore avvia la lettura ma non la chiude mai da solo; uno stato scelto a mano resta com'e'.
      if (book.readingStatus === 'unread' && book.fieldSource?.readingStatus !== 'manual') {
        patch.readingStatus = 'reading';
      }
      // Primo salvataggio: la lettura inizia oggi (se l'inizio non e' gia' noto).
      if (!book.dateStarted) patch.dateStarted = localDay();
      try {
        await updateBook(book.id, patch, 'file', { touch: false });
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      return { ok: true };
    },
  );

  /**
   * «Segna come non letto»: azzera stato, avanzamento, data di fine e posizioni del
   * lettore. Lo stato non resta «manuale», cosi' una lettura futura in Apple Books
   * puo' aggiornarlo; `readingProgressUpdatedAt` = adesso fa vincere questo reset
   * su un'apertura di Apple Books precedente. Nessuna ricerca online.
   */
  app.post<{ Params: { id: string } }>('/api/books/:id/reset-reading', async (request, reply) => {
    try {
      const current = await getBookMeta(request.params.id);
      const patch: Partial<BookMeta> = {
        readingStatus: 'unread',
        readingProgress: null,
        dateFinished: null,
        readingPositions: {},
        readingProgressUpdatedAt: new Date().toISOString(),
      };
      // Anche l'inizio si azzera, tranne se l'utente lo ha scritto a mano.
      if (current && current.fieldSource?.dateStarted !== 'manual') patch.dateStarted = null;
      return await updateBook(
        request.params.id,
        patch,
        'file',
        { touch: false, clearSources: ['readingStatus'] },
      );
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  /* ---------------------------------------------------- sottolineature -- */
  const APPLE_HIGHLIGHT_ERROR = 'Le sottolineature di Apple Books si modificano in Apple Books';

  /** Salva l'elenco delle sottolineature, nell'ordine di lettura, senza ricerche online. */
  const saveHighlights = (id: string, highlights: BookHighlight[]) =>
    updateBook(id, { highlights: [...highlights].sort(compareLocations) }, 'manual', { touch: false });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/books/:id/highlights',
    async (request, reply) => {
      const book = await getBookMeta(request.params.id);
      if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
      const { file, location, text, color, note, chapter } = request.body ?? {};
      const epubs = [book.sourceFile, ...(book.editions ?? []).map((edition) => edition.file)].filter(
        (name): name is string => Boolean(name) && /\.epub$/i.test(name as string),
      );
      if (typeof file !== 'string' || !epubs.includes(file)) {
        return reply.code(400).send({ error: 'File EPUB non valido per questo libro' });
      }
      if (typeof location !== 'string' || location.length > 2000 || !location.startsWith('epubcfi(')) {
        return reply.code(400).send({ error: 'Posizione non valida' });
      }
      if (typeof text !== 'string' || !text.trim() || text.length > 20000) {
        return reply.code(400).send({ error: 'Testo della sottolineatura non valido (massimo 20000 caratteri)' });
      }
      if (typeof color !== 'string' || !HIGHLIGHT_COLORS.includes(color as HighlightColor)) {
        return reply.code(400).send({ error: 'Colore non valido' });
      }
      if (note !== undefined && (typeof note !== 'string' || note.length > 10000)) {
        return reply.code(400).send({ error: 'Nota non valida (massimo 10000 caratteri)' });
      }
      if (chapter !== undefined && (typeof chapter !== 'string' || chapter.length > 300)) {
        return reply.code(400).send({ error: 'Capitolo non valido' });
      }
      const now = new Date().toISOString();
      const highlight: BookHighlight = {
        id: randomUUID(),
        source: 'reader',
        file,
        text,
        note: typeof note === 'string' ? note : '',
        color: color as HighlightColor,
        location,
        chapter: typeof chapter === 'string' ? chapter : '',
        createdAt: now,
        modifiedAt: now,
      };
      try {
        await saveHighlights(book.id, [...(book.highlights ?? []), highlight]);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      return highlight;
    },
  );

  app.patch<{ Params: { id: string; hid: string }; Body: { color?: unknown; note?: unknown } }>(
    '/api/books/:id/highlights/:hid',
    async (request, reply) => {
      const book = await getBookMeta(request.params.id);
      if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
      const current = (book.highlights ?? []).find((item) => item.id === request.params.hid);
      if (!current) return reply.code(404).send({ error: 'Sottolineatura non trovata' });
      if (current.source === 'applebooks') return reply.code(409).send({ error: APPLE_HIGHLIGHT_ERROR });
      const { color, note } = request.body ?? {};
      if (color !== undefined && (typeof color !== 'string' || !HIGHLIGHT_COLORS.includes(color as HighlightColor))) {
        return reply.code(400).send({ error: 'Colore non valido' });
      }
      if (note !== undefined && (typeof note !== 'string' || note.length > 10000)) {
        return reply.code(400).send({ error: 'Nota non valida (massimo 10000 caratteri)' });
      }
      const updated: BookHighlight = {
        ...current,
        ...(color !== undefined ? { color: color as HighlightColor } : {}),
        ...(note !== undefined ? { note: note as string } : {}),
        modifiedAt: new Date().toISOString(),
      };
      try {
        await saveHighlights(
          book.id,
          (book.highlights ?? []).map((item) => (item.id === updated.id ? updated : item)),
        );
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      return updated;
    },
  );

  app.delete<{ Params: { id: string; hid: string } }>(
    '/api/books/:id/highlights/:hid',
    async (request, reply) => {
      const book = await getBookMeta(request.params.id);
      if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
      const current = (book.highlights ?? []).find((item) => item.id === request.params.hid);
      if (!current) return reply.code(404).send({ error: 'Sottolineatura non trovata' });
      if (current.source === 'applebooks') return reply.code(409).send({ error: APPLE_HIGHLIGHT_ERROR });
      try {
        await saveHighlights(
          book.id,
          (book.highlights ?? []).filter((item) => item.id !== current.id),
        );
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------- copertine -- */
  app.get<{ Params: { id: string }; Querystring: { w?: string; t?: string } }>(
    '/api/covers/:id',
    async (request, reply) => {
    const record = await getBookRecord(request.params.id);
    if (!record?.coverPath) return reply.code(404).send({ error: 'Copertina assente' });
    // Con la versione (t) il contenuto non cambia mai per quell'URL; le copertine
    // stanno dietro il login, quindi la cache e' solo del browser (private).
    const cacheControl = request.query.t
      ? 'private, max-age=31536000, immutable'
      : 'private, max-age=86400';
    try {
      // Miniature solo alle larghezze ammesse; altrimenti si serve l'originale.
      const width = request.query.w === '120' ? 120 : request.query.w === '480' ? 480 : 0;
      if (width) {
        const thumb = await getCoverThumbnail(request.params.id, record.coverPath, width);
        if (thumb) {
          return reply
            .header('Content-Type', thumb.type)
            .header('Cache-Control', cacheControl)
            .send(thumb.data);
        }
      }
      const data = await fsp.readFile(record.coverPath);
      const ext = path.extname(record.coverPath).toLowerCase();
      return reply
        .header('Content-Type', COVER_MIME[ext] ?? 'application/octet-stream')
        .header('Cache-Control', cacheControl)
        .send(data);
    } catch {
      return reply.code(404).send({ error: 'Copertina non trovata' });
    }
    },
  );

  app.post<{ Params: { id: string } }>('/api/books/:id/cover', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'Nessun file ricevuto' });
    const buffer = await file.toBuffer();
    if (buffer.length > 25 * 1024 * 1024) {
      return reply.code(413).send({ error: 'Copertina troppo grande (max 25 MB)' });
    }
    const ext = path.extname(file.filename ?? '.jpg').toLowerCase() || '.jpg';
    try {
      const updated = await setCover(request.params.id, buffer, ext);
      return updated;
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { url?: string } }>(
    '/api/books/:id/cover/url',
    async (request, reply) => {
      const url = request.body?.url;
      if (!url) return reply.code(400).send({ error: 'URL mancante' });
      try {
        return await downloadCoverToFolder(request.params.id, url);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/books/:id/cover/extract', async (request, reply) => {
    try {
      return await extractCoverFromFile(request.params.id);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/books/:id/cover', async (request, reply) => {
    try {
      return await removeCover(request.params.id);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  /* ------------------------------------------------- metadati e provider -- */
  app.post<{ Params: { id: string } }>('/api/books/:id/refresh', async (request, reply) => {
    try {
      return await refreshFromFile(request.params.id);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/books/:id/lookup', async (request, reply) => {
    const book = await getBookMeta(request.params.id);
    if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
    const settings = await loadSettings();
    try {
      const outcome = await lookupOnline(book, settings.providers, settings.searchLanguage, {
        googleBooksApiKey: settings.googleBooksApiKey,
      });
      return {
        candidates: outcome.candidates,
        errors: outcome.errors,
        missing: missingFields(book),
      };
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { url?: string } }>(
    '/api/books/:id/lookup/google',
    async (request, reply) => {
      const book = await getBookMeta(request.params.id);
      if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
      const input = (request.body?.url ?? '').trim();
      if (!input) return reply.code(400).send({ error: 'Incolla un link o un ID Google Books' });
      const settings = await loadSettings();
      try {
        const candidate = await lookupGoogleVolume(input, {
          googleBooksApiKey: settings.googleBooksApiKey,
        });
        return {
          candidates: [candidate],
          errors: [],
          missing: missingFields(book),
        };
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { url?: string } }>(
    '/api/books/:id/lookup/ao3',
    async (request, reply) => {
      const book = await getBookMeta(request.params.id);
      if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
      const input = (request.body?.url ?? '').trim();
      if (!input) return reply.code(400).send({ error: "Incolla un link AO3 o l'ID dell'opera" });
      try {
        const candidate = await lookupFanficPage(input);
        return {
          candidates: [candidate],
          errors: [],
          missing: missingFields(book),
        };
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{
    Body: {
      series?: string;
      authors?: string[];
      isbns?: string[];
      ao3Urls?: string[];
      kind?: 'book' | 'fanfic';
      refresh?: boolean;
    };
  }>('/api/series/lookup', async (request, reply) => {
    const series = (request.body?.series ?? '').trim();
    if (!series) return reply.code(400).send({ error: 'Nome della serie mancante' });
    const authors = Array.isArray(request.body?.authors)
      ? request.body.authors.filter((author) => typeof author === 'string')
      : [];
    const isbns = Array.isArray(request.body?.isbns)
      ? request.body.isbns.filter((isbn) => typeof isbn === 'string')
      : [];
    const ao3Urls = Array.isArray(request.body?.ao3Urls)
      ? request.body.ao3Urls.filter((url) => typeof url === 'string')
      : [];
    const settings = await loadSettings();
    try {
      return await lookupSeries(series, authors, settings.providers, {
        googleBooksApiKey: settings.googleBooksApiKey,
        refresh: Boolean(request.body?.refresh),
        refreshDays: settings.seriesRefreshDays,
        isbns,
        ao3Urls,
        kind: request.body?.kind === 'fanfic' ? 'fanfic' : 'book',
      });
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  // Lettura in blocco dalla cache, senza rete: serve a mostrare subito i mancanti.
  app.post<{
    Body: {
      groups?: Array<{ series?: string; authors?: string[]; kind?: 'book' | 'fanfic' }>;
    };
  }>('/api/series/cached', async (request, reply) => {
    const groups = request.body?.groups;
    if (!Array.isArray(groups)) return reply.code(400).send({ error: 'Elenco delle serie mancante' });
    if (groups.length > 500) return reply.code(400).send({ error: 'Troppe serie (massimo 500)' });
    const settings = await loadSettings();
    const results = await Promise.all(
      groups.map((group) =>
        readCachedSeries(
          typeof group?.series === 'string' ? group.series : '',
          Array.isArray(group?.authors)
            ? group.authors.filter((author) => typeof author === 'string')
            : [],
          group?.kind === 'fanfic' ? 'fanfic' : 'book',
          settings.seriesRefreshDays,
        ),
      ),
    );
    return { results };
  });

  app.get('/api/series/totals', async () => readSeriesTotals());

  app.put<{ Body: { key?: string; total?: number | null } }>(
    '/api/series/totals',
    async (request, reply) => {
      const total = request.body?.total;
      if (total === undefined) return reply.code(400).send({ error: 'Totale mancante' });
      try {
        return await writeSeriesTotal(
          typeof request.body?.key === 'string' ? request.body.key : '',
          total === null ? null : Number(total),
        );
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{ Body: { dryRun?: boolean } }>(
    '/api/apple-books/import',
    async (request, reply) => {
      try {
        return await importAppleBooks({ dryRun: Boolean(request.body?.dryRun) });
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /**
   * Dice se il server legge Apple Books da se' (macOS o container indicato).
   * APPLE_BOOKS_FORCE_REMOTE=1 simula un server remoto: serve solo alle prove.
   */
  app.get('/api/apple-books/capabilities', async () => ({
    local:
      process.env.APPLE_BOOKS_FORCE_REMOTE !== '1' &&
      (process.platform === 'darwin' || Boolean(process.env.APPLE_BOOKS_CONTAINER)),
  }));

  /** Import dai dati letti dall'app per Mac (annotazioni e libreria di Apple Books). */
  app.post(
    '/api/apple-books/import-data',
    { bodyLimit: 50 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const { data, dryRun, bookIds } = parseAppleBooksInput(request.body);
        return await importAppleBooksFromRows(data, { dryRun, bookIds });
      } catch (error) {
        const status = error instanceof AppleBooksInputError ? error.status : 400;
        return reply.code(status).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { candidate: MetadataCandidate } }>(
    '/api/books/:id/apply',
    async (request, reply) => {
      const candidate = request.body?.candidate;
      if (!candidate) return reply.code(400).send({ error: 'Candidato mancante' });
      try {
        return await applyCandidate(request.params.id, candidate);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /* ----------------------------------------------------------- libreria -- */
  /* --------------------------------------------------------------- EFP -- */
  app.post<{ Body: { url?: string; mode?: 'update' | 'new' } }>(
    '/api/efp/import',
    async (request, reply) => {
      const url = request.body?.url?.trim();
      if (!url) return reply.code(400).send({ error: 'Incolla il link di una storia EFP.' });
      const mode = request.body?.mode;
      if (mode !== undefined && mode !== 'update' && mode !== 'new') {
        return reply.code(400).send({ error: 'Modalita\' di import non valida.' });
      }
      try {
        const result = await importEfpStory(url, { mode });
        if ('duplicate' in result) {
          return reply
            .code(409)
            .send({ ...duplicateReply(result.duplicate), ...(result.canUpdate ? { canUpdate: true } : {}) });
        }
        await syncAppleBooksForBooks([result.book.id]);
        const book = (await getBookMeta(result.book.id)) ?? result.book;
        return {
          book,
          created: result.created,
          chapters: result.story.chapters.length,
          words: result.story.wordCount,
        };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.post<{ Body: { url?: string; format?: 'odt' | 'epub' } }>(
    '/api/efp/download',
    async (request, reply) => {
      const url = request.body?.url?.trim();
      if (!url) return reply.code(400).send({ error: 'Incolla il link di una storia EFP.' });
      const format = request.body?.format === 'epub' ? 'epub' : 'odt';
      try {
        const story = await loadEfpStory(url);
        const data = format === 'epub' ? await buildEpub(story) : await buildOdt(story);
        const name = (story.title.replace(/[<>:"/\\|?*]/g, '-').trim() || 'storia-efp')
          .slice(0, 100);
        const filename = `${name}.${format}`;
        return reply
          .header(
            'Content-Type',
            format === 'epub' ? 'application/epub+zip' : 'application/vnd.oasis.opendocument.text',
          )
          .header('Content-Disposition', attachmentHeader(filename))
          .header('Cache-Control', 'no-store')
          .send(data);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  app.post('/api/library/scan', async () => scanLibrary());

  app.post<{ Body: { path?: string; force?: boolean; attachTo?: string } }>('/api/library/import', async (request, reply) => {
    const requested = request.body?.path;
    if (!requested || typeof requested !== 'string') return reply.code(400).send({ error: 'Percorso mancante' });
    const guard = await guardImportPath(requested);
    if ('error' in guard) return reply.code(403).send({ error: guard.error });
    const target = guard.path;
    let prepared: PreparedImport | null = null;
    try {
      // Un file (o una cartella) che appartiene gia' a un libro non si reimporta:
      // importFile lo sposterebbe nella cartella nuova, lasciando l'altro libro
      // senza file. Per aggiornarne i dati c'e' «Rileggi i metadati dal file».
      const settings = await loadSettings();
      // Un percorso dentro un'altra libreria non si importa: per portare un libro
      // da una libreria all'altra c'e' «Sposta in...».
      const current = currentLibrary();
      for (const other of await allLibraryRoots()) {
        if (other.id === current.id) continue;
        if (await isInsideFolder(other.root, target)) {
          return reply.code(400).send({
            error: `Il file si trova nella libreria «${other.name}»: per portarlo qui usa «Sposta in...» sulla scheda del libro`,
          });
        }
      }
      const relative = path.relative(path.resolve(settings.libraryRoot), path.resolve(target));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const owner = (await loadIndex()).find(
          (book) => relative === book.folder || relative.startsWith(book.folder + path.sep),
        );
        if (owner) {
          return reply.code(400).send({
            error: `Il file fa gia' parte della libreria («${owner.title}»). Per aggiornarlo usa «Rileggi i metadati dal file» nella sua scheda`,
          });
        }
      }
      const attachTo = request.body?.attachTo;
      const force = Boolean(request.body?.force);
      // MOBI, AZW3, FB2, DJVU... vengono convertiti prima di tutti i controlli.
      prepared = await prepareImport(target, { force: force || Boolean(attachTo) });
      if (attachTo) {
        // Il file diventa un'altra lingua di un libro esistente.
        const book = await getBookMeta(attachTo);
        if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
        const same = await findIdenticalFile(book, prepared.path);
        if (same) {
          return reply.code(409).send({
            error: `Il file e' identico a «${same}», gia' presente nella scheda`,
            duplicate: { reason: 'file', book: toSummary(book) },
          });
        }
        return await attachEdition(attachTo, prepared.path);
      }
      if (!force) {
        const duplicate = prepared.duplicate ?? (await findDuplicate(prepared.path));
        if (duplicate) {
          return reply.code(409).send(duplicateReply(duplicate));
        }
      }
      const meta = await importPath(prepared.path, { original: prepared.original });
      // Appena aggiunto, il libro recupera da Apple Books sottolineature, note
      // e avanzamento: l'operazione non blocca l'import se Apple Books manca.
      await syncAppleBooksForBooks([meta.id]);
      return (await getBookMeta(meta.id)) ?? meta;
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    } finally {
      await prepared?.cleanup();
    }
  });

  app.get('/api/library/folders', async () => {
    const settings = await loadSettings();
    try {
      const entries = await fsp.readdir(settings.libraryRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  });

  /** Caricamento di un file dal browser: viene importato nella libreria. */
  app.post<{ Querystring: { force?: string; attachTo?: string } }>(
    '/api/library/upload',
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: 'Nessun file ricevuto' });
      const tempPath = await stageUploadOrReply(reply, file.filename, file.file);
      if (!tempPath) return reply;
      let prepared: PreparedImport | null = null;
      try {
        const attachTo = request.query?.attachTo;
        const force = request.query?.force === '1';
        // MOBI, AZW3, FB2, DJVU... vengono convertiti prima di tutti i controlli
        // (puo' richiedere minuti: la risposta arriva a conversione finita).
        prepared = await prepareImport(tempPath, { force: force || Boolean(attachTo) });
        if (attachTo) {
          // Il file diventa un'altra lingua di un libro esistente.
          const book = await getBookMeta(attachTo);
          if (!book) return reply.code(404).send({ error: 'Libro non trovato' });
          const same = await findIdenticalFile(book, prepared.path);
          if (same) {
            return reply.code(409).send({
              error: `Il file e' identico a «${same}», gia' presente nella scheda`,
              duplicate: { reason: 'file', book: toSummary(book) },
            });
          }
          return await attachEdition(attachTo, prepared.path);
        }
        if (!force) {
          const duplicate = prepared.duplicate ?? (await findDuplicate(prepared.path));
          if (duplicate) {
            return reply.code(409).send(duplicateReply(duplicate));
          }
        }
        const meta = await importPath(prepared.path, { original: prepared.original });
        await syncAppleBooksForBooks([meta.id]);
        return (await getBookMeta(meta.id)) ?? meta;
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      } finally {
        await prepared?.cleanup();
        await fsp.rm(tempPath, { force: true });
      }
    },
  );

  app.post<{ Body: { title?: string; authors?: string[]; kind?: 'book' | 'fanfic' } }>(
    '/api/library/new',
    async (request, reply) => {
      const settings = await loadSettings();
      const title = (request.body?.title ?? '').trim() || 'Senza titolo';
      const authors = request.body?.authors ?? [];
      const kind = request.body?.kind === 'fanfic' ? 'fanfic' : 'book';
      const folderName = (authors.length ? `${authors.join(', ')} - ${title}` : title)
        .replace(/[\\/:*?"<>|]/g, '-')
        .trim();
      const folderPath = path.join(settings.libraryRoot, folderName);
      await fsp.mkdir(folderPath, { recursive: true });

      const meta = emptyMeta();
      meta.folder = path.relative(settings.libraryRoot, folderPath);
      meta.title = title;
      meta.authors = authors;
      meta.kind = kind;
      await writeBookJsonPublic(folderPath, meta);

      const index = await loadIndex();
      await saveIndex([...index.filter((b) => b.folder !== meta.folder), meta]);
      notifyBook(currentLibrary(), meta.id, 'new');
      await syncAppleBooksForBooks([meta.id]);
      return (await getBookMeta(meta.id)) ?? meta;
    },
  );

  app.get('/api/stats', async () => statsFor(visibleBooks(currentLibrary(), await loadIndex())));

  /** Statistiche di lettura per la vista «Statistiche»: `year` e' un anno (AAAA) oppure `all`. */
  app.get<{ Querystring: { year?: string } }>('/api/stats/reading', async (request, reply) => {
    const raw = (request.query.year ?? 'all').trim();
    const year = raw === 'all' ? 'all' : /^\d{4}$/.test(raw) ? Number(raw) : null;
    if (year === null || (year !== 'all' && (year < 1900 || year > 2200))) {
      return reply.code(400).send({ error: 'Anno non valido: indica un anno (AAAA) oppure «all»' });
    }
    const settings = await loadSettings();
    const visible = visibleBooks(currentLibrary(), await loadIndex());
    return computeReadingStats(visible, year, settings.wordsPerHour);
  });
}

/** Campi che l'utente puo' modificare a mano. */
function pickAllowed(body: Partial<BookMeta>): Partial<BookMeta> {
  const allowed: (keyof BookMeta)[] = [
    'title',
    'subtitle',
    'authors',
    'series',
    'seriesIndex',
    'kind',
    'publisher',
    'publishedDate',
    'language',
    'isbn',
    'identifiers',
    'description',
    'pageCount',
    'wordCount',
    'charCount',
    'fandom',
    'ships',
    'characters',
    'relationships',
    'fanRating',
    'tags',
    'status',
    'chapters',
    'ao3Url',
    'ffnetUrl',
    'efpUrl',
    'notes',
    'rating',
    'favorite',
    'readingStatus',
    'readingProgress',
    'dateStarted',
    'dateFinished',
    'lastRead',
    'folder',
    'coverFile',
    // `editions` ed `extraFiles` non ci sono: li gestisce solo il server.
  ];
  const result: Partial<BookMeta> = {};
  for (const key of allowed) {
    if (key in body) {
      (result as Record<string, unknown>)[key] = body[key];
    }
  }
  // Voto a mezze stelle fra 0,5 e 5; qualunque altro valore lo azzera.
  if ('rating' in result) {
    const rating = Number(result.rating);
    result.rating =
      result.rating == null || !Number.isFinite(rating) || rating <= 0
        ? null
        : Math.min(5, Math.max(0.5, Math.round(rating * 2) / 2));
  }
  if ('readingStatus' in result && !READING_STATUSES.includes(result.readingStatus as ReadingStatus)) {
    delete result.readingStatus;
  }
  return result;
}

export function missingFields(book: BookMeta): string[] {
  const missing: string[] = [];
  if (!book.title) missing.push('title');
  if (!book.authors.length) missing.push('authors');
  if (!book.description) missing.push('description');
  if (!book.publisher && book.kind === 'book') missing.push('publisher');
  if (!book.publishedDate) missing.push('publishedDate');
  if (!book.language) missing.push('language');
  if (!book.isbn && book.kind === 'book') missing.push('isbn');
  if (!book.coverFile) missing.push('cover');
  if (book.kind === 'fanfic') {
    if (!book.fandom) missing.push('fandom');
    if (!book.fanRating) missing.push('fanRating');
    if (!book.status) missing.push('status');
    if (!book.wordCount) missing.push('wordCount');
  }
  return missing;
}
