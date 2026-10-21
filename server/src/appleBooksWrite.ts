import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { XMLValidator } from 'fast-xml-parser';
import { locateDatabases, sqliteJson } from './appleBooks.js';
import { DATA_DIR } from './config.js';
import { rewriteOpf, sniffImage, toImageFormat } from './epubWrite.js';
import type { BookRecord } from './library.js';

const execFileAsync = promisify(execFile);

/** Campi che si possono scrivere su Apple Books. */
export type AppleBooksField = 'title' | 'authors' | 'cover';

export interface AppleBooksAsset {
  assetId: string;
  /** Cartella .epub scompattata di Apple Books. */
  path: string;
  /** Titolo e autore attuali (dagli attributi estesi). */
  title: string;
  author: string;
  /** Percorso assoluto della copertina dichiarata nell'OPF, se c'e'. */
  coverFile?: string;
}

export interface AppleBooksStatus {
  available: boolean;
  reason?: string;
  asset?: AppleBooksAsset;
}

export interface AppleBooksWriteResult {
  written: AppleBooksField[];
  backup: string;
  reopened: boolean;
}

/** Errore con un codice, cosi' la rotta puo' rispondere 409 per "Apple Books e' aperto". */
export class AppleBooksError extends Error {
  constructor(
    message: string,
    readonly code: 'running' | 'failed' = 'failed',
  ) {
    super(message);
  }
}

/** Funzioni sostituibili: servono alle prove, per non toccare l'app vera. */
export interface AppleBooksDeps {
  isRunning: () => Promise<boolean>;
  quit: () => Promise<void>;
  open: () => Promise<void>;
  /** Solo per le prove: chiamata dopo la scrittura e prima dei controlli finali. */
  afterWrite?: (asset: AppleBooksAsset) => Promise<void>;
}

const XATTR_ASSET = 'com.apple.iBooks.assetID#S';
const XATTR_TITLE = 'com.apple.iBooks.title#S';
const XATTR_AUTHOR = 'com.apple.iBooks.author#S';
const KEEP_BACKUPS = 3;

/** Radice dei documenti iCloud di Apple Books (configurabile con APPLE_BOOKS_ICLOUD_DOCS). */
function icloudDocs(): string {
  const configured = process.env.APPLE_BOOKS_ICLOUD_DOCS?.trim();
  if (configured) return path.resolve(configured.replace(/^~(?=\/|$)/, os.homedir()));
  return path.join(os.homedir(), 'Library/Mobile Documents/iCloud~com~apple~iBooks/Documents');
}

function decodeUriSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // href con percentuali non valide: valore grezzo.
    return value;
  }
}

async function readXattr(file: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('xattr', ['-p', name, file]);
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
}

async function writeXattr(file: string, name: string, value: string): Promise<void> {
  await execFileAsync('xattr', ['-w', name, value, file]);
}

/** Percorso dell'OPF (assoluto) letto da META-INF/container.xml. */
async function findOpf(folder: string): Promise<string> {
  const container = await fsp.readFile(path.join(folder, 'META-INF', 'container.xml'), 'utf8').catch(() => '');
  const match = /<(?:[\w-]+:)?rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(container);
  const rel = match ? (match[1] ?? match[2] ?? '') : '';
  if (!rel) throw new AppleBooksError('Cartella di Apple Books non valida: OPF non trovato');
  const opf = path.resolve(folder, decodeUriSafe(rel));
  if (!opf.startsWith(folder + path.sep)) throw new AppleBooksError('Cartella di Apple Books non valida: OPF fuori cartella');
  return opf;
}

/** Cerca la cartella del libro: prima da ZPATH del database, poi scorrendo Documents. */
async function findFolder(assetId: string): Promise<{ folder: string | null; store: boolean; pdf: boolean }> {
  const docs = icloudDocs();
  let store = false;
  let pdf = false;
  const candidates: string[] = [];
  try {
    const { library } = await locateDatabases();
    if (library) {
      const safe = assetId.replace(/[^0-9A-Za-z_-]/g, '');
      const rows = await sqliteJson<{ ZPATH: string | null; ZSTOREID: string | null }>(
        library,
        `SELECT ZPATH, ZSTOREID FROM ZBKLIBRARYASSET WHERE ZASSETID = '${safe}' LIMIT 1`,
      );
      const row = rows[0];
      if (row) {
        if (row.ZSTOREID && row.ZSTOREID !== '0') store = true;
        const zpath = row.ZPATH ?? '';
        if (/\.pdf$/i.test(zpath)) pdf = true;
        // Si usa solo il nome: la radice e' quella configurata (anche nelle prove).
        else if (zpath) candidates.push(path.join(docs, path.basename(zpath)));
      }
    }
  } catch {
    // Database non leggibile: si ripiega sulla scansione di Documents.
  }
  const matches = async (dir: string): Promise<boolean> => (await readXattr(dir, XATTR_ASSET)) === assetId;
  for (const dir of candidates) if (await matches(dir)) return { folder: dir, store, pdf };
  if (store || pdf) return { folder: null, store, pdf };
  const names = await fsp.readdir(docs).catch(() => [] as string[]);
  for (const name of names) {
    if (!/\.epub$/i.test(name)) continue;
    const dir = path.join(docs, name);
    const stat = await fsp.stat(dir).catch(() => null);
    if (stat?.isDirectory() && (await matches(dir))) return { folder: dir, store, pdf };
  }
  return { folder: null, store, pdf };
}

/** Copertina dichiarata nell'OPF (percorso assoluto), cercando cover-image o meta cover. */
async function declaredCover(folder: string, opfFile: string): Promise<string | undefined> {
  const opf = await fsp.readFile(opfFile, 'utf8').catch(() => '');
  const items = [...opf.matchAll(/<(?:[\w-]+:)?item\b([^>]*?)\/?>/gi)].map((m) => m[1] ?? '');
  const get = (attrs: string, name: string): string | undefined => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    return m ? (m[1] ?? m[2] ?? '') : undefined;
  };
  let item = items.find((a) => (get(a, 'properties') ?? '').split(/\s+/).includes('cover-image'));
  if (!item) {
    const id = /<(?:[\w-]+:)?meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i.exec(opf)?.[1];
    if (id) item = items.find((a) => get(a, 'id') === id);
  }
  const href = item ? get(item, 'href') : undefined;
  if (!item || !href || !(get(item, 'media-type') ?? '').toLowerCase().startsWith('image/')) return undefined;
  const file = path.resolve(path.dirname(opfFile), decodeUriSafe(href));
  return file.startsWith(folder + path.sep) ? file : undefined;
}

/** Dice se la scheda si puo' scrivere su Apple Books e, in caso, dove si trova. */
export async function appleBooksStatus(book: BookRecord): Promise<AppleBooksStatus> {
  if (process.platform !== 'darwin') return { available: false, reason: 'Disponibile solo su macOS' };
  const assetId = book.meta.identifiers?.applebooks;
  if (!assetId) return { available: false, reason: 'Questo libro non e\' collegato ad Apple Books' };
  if (book.meta.format === 'pdf') return { available: false, reason: 'I PDF di Apple Books non si possono modificare' };
  const { folder, store, pdf } = await findFolder(assetId);
  if (store) return { available: false, reason: 'Libro acquistato dallo Store: Apple Books non permette di modificarlo' };
  if (pdf) return { available: false, reason: 'I PDF di Apple Books non si possono modificare' };
  if (!folder) return { available: false, reason: 'Cartella del libro non trovata in Apple Books' };
  try {
    const opf = await findOpf(folder);
    return {
      available: true,
      asset: {
        assetId,
        path: folder,
        title: (await readXattr(folder, XATTR_TITLE)) ?? '',
        author: (await readXattr(folder, XATTR_AUTHOR)) ?? '',
        coverFile: await declaredCover(folder, opf),
      },
    };
  } catch (error) {
    return { available: false, reason: (error as Error).message };
  }
}

const defaultDeps: AppleBooksDeps = {
  isRunning: async () => {
    try {
      await execFileAsync('pgrep', ['-x', 'Books']);
      return true;
    } catch {
      return false;
    }
  },
  quit: async () => {
    await execFileAsync('osascript', ['-e', 'tell application "Books" to quit']);
  },
  open: async () => {
    await execFileAsync('open', ['-a', 'Books']);
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tiene solo gli ultimi backup del libro (le cartelle hanno per nome un timestamp ordinabile). */
async function pruneBackups(bookDir: string): Promise<void> {
  const names = (await fsp.readdir(bookDir).catch(() => [] as string[])).sort();
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
    await fsp.rm(path.join(bookDir, name), { recursive: true, force: true });
  }
}

/**
 * Scrive copertina, titolo e autore della scheda nella copia del libro che
 * Apple Books ha gia'. L'assetID non si tocca mai: annotazioni e progressi
 * restano legati al libro. Il contenuto dell'OPF si riscrive nello stesso
 * file (stesso inode) e il database della libreria non si modifica.
 */
export async function writeToAppleBooks(
  book: BookRecord,
  options: { fields: AppleBooksField[]; quitApp?: boolean },
  overrides: Partial<AppleBooksDeps> = {},
): Promise<AppleBooksWriteResult> {
  const deps = { ...defaultDeps, ...overrides };
  const fields = [...new Set(options.fields)];
  if (!fields.length) throw new AppleBooksError('Scegli almeno un campo da scrivere');
  const status = await appleBooksStatus(book);
  if (!status.available || !status.asset) {
    throw new AppleBooksError(status.reason ?? 'Apple Books non disponibile per questo libro');
  }
  const asset = status.asset;
  const meta = book.meta;
  const authors = (meta.authors ?? []).map((a) => a.trim()).filter(Boolean);
  if (fields.includes('title') && !meta.title.trim()) throw new AppleBooksError('La scheda non ha un titolo');
  if (fields.includes('authors') && !authors.length) throw new AppleBooksError('La scheda non ha autori');
  const coverRaw = fields.includes('cover') && book.coverPath ? await fsp.readFile(book.coverPath).catch(() => null) : null;
  if (fields.includes('cover') && !coverRaw?.length) throw new AppleBooksError('La scheda non ha una copertina');

  /* 1. Apple Books aperto: con il consenso si chiude e si riapre alla fine. */
  let quitByUs = false;
  if (await deps.isRunning()) {
    if (!options.quitApp) throw new AppleBooksError('Chiudi Apple Books e riprova', 'running');
    await deps.quit();
    for (let i = 0; i < 30 && (await deps.isRunning()); i += 1) await sleep(500);
    if (await deps.isRunning()) throw new AppleBooksError('Apple Books non si e\' chiuso: chiudilo e riprova', 'running');
    quitByUs = true;
  }

  const folder = asset.path;
  const opfFile = await findOpf(folder);
  const originalOpf = await fsp.readFile(opfFile);
  const originalCover = asset.coverFile ? await fsp.readFile(asset.coverFile).catch(() => null) : null;
  const created: string[] = [];

  /* 2. Backup completo della cartella (ditto conserva gli attributi estesi). */
  const bookBackups = path.join(DATA_DIR, 'applebooks-backups', asset.assetId);
  const backup = path.join(bookBackups, new Date().toISOString().replace(/[:.]/g, '-'));
  await fsp.mkdir(bookBackups, { recursive: true });
  await execFileAsync('ditto', [folder, backup]);

  // Ripristino: si riscrivono i byte nello stesso file, senza cambiare inode.
  const restore = async (): Promise<void> => {
    await fsp.writeFile(opfFile, originalOpf);
    if (asset.coverFile && originalCover) await fsp.writeFile(asset.coverFile, originalCover);
    for (const file of created) await fsp.rm(file, { force: true });
    await writeXattr(folder, XATTR_TITLE, asset.title);
    await writeXattr(folder, XATTR_AUTHOR, asset.author);
    await writeXattr(folder, XATTR_ASSET, asset.assetId);
  };

  let coverFile: string | null = null;
  try {
    /* 3. OPF e copertina. */
    const { opf, coverPlan } = rewriteOpf(originalOpf.toString('utf8'), meta, {
      fields,
      cover: coverRaw ? { kind: sniffImage(coverRaw) } : undefined,
    });
    if (coverPlan && coverRaw) {
      const data = await toImageFormat(coverRaw, coverPlan.target);
      const target = path.resolve(path.dirname(opfFile), decodeUriSafe(coverPlan.href));
      if (!target.startsWith(folder + path.sep)) throw new Error('percorso della copertina non valido');
      coverFile = target;
      const exists = await fsp.stat(target).then(() => true, () => false);
      if (!exists) created.push(target);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
    }
    await fsp.writeFile(opfFile, opf);

    /* 4. Attributi che Apple Books mostra e sincronizza con iCloud. */
    if (fields.includes('title')) await writeXattr(folder, XATTR_TITLE, meta.title.trim());
    if (fields.includes('authors')) await writeXattr(folder, XATTR_AUTHOR, authors.join(', '));

    if (deps.afterWrite) await deps.afterWrite(asset);

    /* 5. Controlli finali. */
    if ((await readXattr(folder, XATTR_ASSET)) !== asset.assetId) throw new Error('l\'identita\' del libro e\' cambiata');
    const valid = XMLValidator.validate(await fsp.readFile(opfFile, 'utf8'));
    if (valid !== true) throw new Error(`OPF non valido: ${valid.err.msg}`);
    if (coverFile) {
      const stat = await fsp.stat(coverFile).catch(() => null);
      if (!stat || !stat.size) throw new Error('file di copertina mancante');
    }
  } catch (error) {
    try {
      await restore();
    } catch (restoreError) {
      throw new AppleBooksError(
        `Scrittura fallita (${(error as Error).message}) e ripristino non riuscito (${(restoreError as Error).message}). ` +
          `Il backup e' in ${backup}`,
      );
    }
    throw new AppleBooksError(`Scrittura su Apple Books annullata, libro ripristinato: ${(error as Error).message}`);
  }

  await pruneBackups(bookBackups);

  /* 6. Si riapre l'app solo se l'abbiamo chiusa noi. */
  let reopened = false;
  if (quitByUs) {
    await deps.open().then(
      () => {
        reopened = true;
      },
      () => undefined,
    );
  }
  return { written: fields, backup, reopened };
}
