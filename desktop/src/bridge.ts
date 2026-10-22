import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { readAppleBooksData } from '../../server/src/appleBooksRead';
import {
  AppleBooksError,
  appleBooksStatus,
  writeToAppleBooks,
  type AppleBooksDeps,
  type AppleBooksField,
} from '../../server/src/appleBooksWrite';
import type { BookMeta } from '../../shared/types';
import type { BridgeResult } from './common';

// Logica dei metodi del ponte, tutta su dati locali: nessuna richiesta al server.

const MAX_BOOK_BYTES = 400 * 1024 * 1024;
const MAX_COVER_BYTES = 25 * 1024 * 1024;
const MAX_META_JSON = 2 * 1024 * 1024;
const ALLOWED_FIELDS: AppleBooksField[] = ['title', 'authors', 'cover'];
const ONE_DAY = 24 * 60 * 60 * 1000;

function fail(error: unknown): BridgeResult<never> {
  if (error instanceof AppleBooksError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return { ok: false, code: 'failed', message: (error as Error).message || 'Errore sconosciuto' };
}

/** Errore di validazione degli argomenti. */
class ArgError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accetta ArrayBuffer o Uint8Array e controlla la dimensione. */
function toBuffer(value: unknown, max: number, label: string): Buffer {
  let buffer: Buffer;
  if (value instanceof ArrayBuffer) buffer = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else throw new ArgError(`${label} non valido`);
  if (!buffer.length) throw new ArgError(`${label} vuoto`);
  if (buffer.length > max) throw new ArgError(`${label} troppo grande`);
  return buffer;
}

/** La scheda deve avere la forma di un BookMeta (i campi usati dalla scrittura). */
function checkMeta(value: unknown): BookMeta {
  if (!isObject(value)) throw new ArgError('Scheda non valida');
  if (typeof value.id !== 'string' || typeof value.title !== 'string') throw new ArgError('Scheda non valida');
  if (!Array.isArray(value.authors) || !value.authors.every((a) => typeof a === 'string')) {
    throw new ArgError('Autori non validi');
  }
  if (value.identifiers !== undefined && !isObject(value.identifiers)) throw new ArgError('Identificativi non validi');
  if (value.tags !== undefined && !(Array.isArray(value.tags) && value.tags.every((t) => typeof t === 'string'))) {
    throw new ArgError('Etichette non valide');
  }
  if (JSON.stringify(value).length > MAX_META_JSON) throw new ArgError('Scheda troppo grande');
  return value as unknown as BookMeta;
}

export function backupsDir(): string {
  return path.join(app.getPath('userData'), 'applebooks-backups');
}

export async function readApple() {
  try {
    return { ok: true as const, value: await readAppleBooksData() };
  } catch (error) {
    return fail(error);
  }
}

export async function statusApple(metaArg: unknown) {
  try {
    const meta = checkMeta(metaArg);
    return {
      ok: true as const,
      value: await appleBooksStatus({ meta, sourcePath: null, coverPath: null }),
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Solo per le prove: con BOOKS_DESKTOP_TEST_APPS=1 l'app Libri e' simulata (aperta se
 * BOOKS_DESKTOP_TEST_RUNNING=1), cosi' le prove non toccano quella vera.
 */
let simulated: Partial<AppleBooksDeps> | null = null;
function testDeps(): Partial<AppleBooksDeps> {
  if (process.env.BOOKS_DESKTOP_TEST_APPS !== '1') return {};
  if (!simulated) {
    let running = process.env.BOOKS_DESKTOP_TEST_RUNNING === '1';
    simulated = {
      isRunning: async () => running,
      quit: async () => {
        running = false;
      },
      open: async () => undefined,
    };
  }
  return simulated;
}

export async function writeApple(args: unknown) {
  let tmp: string | null = null;
  try {
    if (!isObject(args)) throw new ArgError('Richiesta non valida');
    const meta = checkMeta(args.meta);
    if (!Array.isArray(args.fields) || !args.fields.every((f) => ALLOWED_FIELDS.includes(f as AppleBooksField))) {
      throw new ArgError('Campi non validi');
    }
    const fields = [...new Set(args.fields as AppleBooksField[])];
    if (typeof args.quitApp !== 'boolean') throw new ArgError('Richiesta non valida');
    let coverPath: string | null = null;
    if (args.cover !== undefined) {
      const cover = toBuffer(args.cover, MAX_COVER_BYTES, 'Copertina');
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'books-editor-cover-'));
      coverPath = path.join(tmp, 'cover.bin');
      await fsp.writeFile(coverPath, cover);
    }
    const result = await writeToAppleBooks(
      { meta, sourcePath: null, coverPath },
      { fields, quitApp: args.quitApp, backupsDir: backupsDir() },
      testDeps(),
    );
    return { ok: true as const, value: result };
  } catch (error) {
    return fail(error);
  } finally {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** Cartella dei file passati a Libri (Libri li copia in modo asincrono: non si cancellano subito). */
export function openDir(): string {
  return path.join(app.getPath('userData'), 'open-in-books');
}

/** Nome sicuro: solo il nome del file, caratteri semplici, estensione .epub o .pdf. */
export function safeFilename(raw: unknown): { name: string; ext: '.epub' | '.pdf' } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 400) throw new ArgError('Nome del file non valido');
  const base = path.basename(raw.replace(/\\/g, '/'));
  const ext = path.extname(base).toLowerCase();
  if (ext !== '.epub' && ext !== '.pdf') throw new ArgError('Sono ammessi solo file EPUB e PDF');
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^\p{L}\p{N} ._()'-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 120)
    .trim();
  return { name: `${stem || 'libro'}${ext}`, ext };
}

export async function openInBooks(args: unknown) {
  try {
    if (!isObject(args)) throw new ArgError('Richiesta non valida');
    const { name, ext } = safeFilename(args.filename);
    const data = toBuffer(args.data, MAX_BOOK_BYTES, 'File');
    if (ext === '.epub' && !(data[0] === 0x50 && data[1] === 0x4b)) throw new ArgError('Il file non e\' un EPUB valido');
    if (ext === '.pdf' && data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ArgError('Il file non e\' un PDF valido');
    // Una sottocartella casuale evita collisioni fra libri con lo stesso nome.
    const dir = path.join(openDir(), crypto.randomBytes(6).toString('hex'));
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fsp.writeFile(file, data);
    // Solo per le prove: invece di aprire Libri si registra il percorso.
    const log = process.env.BOOKS_DESKTOP_OPEN_LOG;
    if (log) {
      await fsp.appendFile(log, `${file}\n`);
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile('open', ['-a', 'Books', file], (error) => (error ? reject(error) : resolve()));
      });
    }
    return { ok: true as const, value: { path: file } };
  } catch (error) {
    return fail(error);
  }
}

/** Elimina i file passati a Libri piu' vecchi di un giorno. */
export async function cleanOpenDir(): Promise<void> {
  const root = openDir();
  const names = await fsp.readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    const dir = path.join(root, name);
    const stat = await fsp.stat(dir).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > ONE_DAY) await fsp.rm(dir, { recursive: true, force: true });
  }
}
