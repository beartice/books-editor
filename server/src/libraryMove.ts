import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LibraryError, currentLibrary, getLibrary } from './libraries.js';
import { loadIndex, loadIndexFor, saveIndex, saveIndexFor } from './store.js';
import { notifyBook } from './bookEvents.js';
import { BOOK_JSON, emptyMeta, getBookRecord, readBookJson, uniqueFolderName, writeBookJsonPublic } from './library.js';
import type { BookMeta } from '../../shared/types.js';

/* Spostamento di un libro da una libreria a un'altra (mai una copia). */

export interface MoveOptions {
  /** Salta il rename e forza copia + verifica (come con l'errore EXDEV fra volumi diversi). Solo per le prove. */
  skipRename?: boolean;
  /** File (relativi alla cartella) di cui confrontare lo sha256, oltre a numero e dimensione dei file. */
  hashFiles?: string[];
  /** Solo per le prove: viene chiamata subito dopo la copia (per simulare una copia corrotta). */
  afterCopy?: (copy: string) => Promise<void>;
}

/** Elenco dei file di una cartella (percorso relativo -> dimensione), ricorsivo. */
async function listTree(root: string, dir = root, out = new Map<string, number>()): Promise<Map<string, number>> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listTree(root, full, out);
    else if (entry.isFile()) out.set(path.relative(root, full), (await fsp.stat(full)).size);
  }
  return out;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Confronta due cartelle: stessi file, stesse dimensioni, stesso sha256 dei file indicati. */
async function verifyCopy(source: string, copy: string, hashFiles: string[]): Promise<string | null> {
  const [from, to] = await Promise.all([listTree(source), listTree(copy)]);
  if (from.size !== to.size) return `numero di file diverso (${from.size} contro ${to.size})`;
  for (const [name, size] of from) {
    if (!to.has(name)) return `manca il file ${name}`;
    if (to.get(name) !== size) return `dimensione diversa per ${name}`;
  }
  for (const name of hashFiles) {
    if (!from.has(name)) continue;
    const [a, b] = await Promise.all([sha256(path.join(source, name)), sha256(path.join(copy, name))]);
    if (a !== b) return `contenuto diverso per ${name}`;
  }
  return null;
}

/**
 * Sposta una cartella. Prima prova `rename`; se fallisce con EXDEV (cartelle su
 * volumi diversi, come in Docker) copia, verifica e solo dopo cancella l'originale.
 * Se la verifica fallisce la copia viene cancellata e l'originale resta com'era.
 * `destination` non deve esistere. Restituisce il metodo usato.
 */
export async function moveFolder(
  source: string,
  destination: string,
  options: MoveOptions = {},
): Promise<'rename' | 'copy'> {
  if (!options.skipRename) {
    try {
      await fsp.rename(source, destination);
      return 'rename';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }
  }

  // La destinazione deve essere nuova: cosi' in caso di errore si cancella solo la copia fatta qui.
  if (await fsp.stat(destination).then(() => true, () => false)) {
    throw new LibraryError(500, 'La cartella di destinazione esiste gia\': il libro non e\' stato spostato');
  }
  try {
    await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await options.afterCopy?.(destination);
    const problem = await verifyCopy(source, destination, options.hashFiles ?? [BOOK_JSON]);
    if (problem) throw new LibraryError(500, `Verifica della copia fallita (${problem}): il libro non e' stato spostato`);
  } catch (error) {
    // La copia e' nostra (destination non esisteva): si toglie, l'originale non si tocca.
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof LibraryError) throw error;
    throw new LibraryError(
      500,
      `Copia del libro non riuscita (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): il libro non e' stato spostato`,
    );
  }
  try {
    await fsp.rm(source, { recursive: true, force: true });
  } catch (error) {
    // La copia e' completa e verificata: non si butta. Resta pero' un residuo da togliere a mano.
    throw new LibraryError(
      500,
      `Libro copiato, ma non e' stato possibile eliminare la cartella originale (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): controlla le due librerie`,
    );
  }
  return 'copy';
}

const moving = new Set<string>();

/** Sposta un libro dalla libreria corrente a quella indicata. L'id del libro non cambia. */
export async function moveBookToLibrary(bookId: string, toId: string): Promise<{ to: string; book: BookMeta }> {
  const from = currentLibrary();
  const record = await getBookRecord(bookId);
  if (!record) throw new LibraryError(404, 'Libro non trovato');
  const target = await getLibrary(toId);
  if (!target) throw new LibraryError(404, 'Libreria di destinazione inesistente');
  if (target.id === from.id) throw new LibraryError(400, 'Il libro e\' gia\' in questa libreria');
  if (moving.has(bookId)) throw new LibraryError(409, 'Questo libro e\' gia\' in fase di spostamento');

  moving.add(bookId);
  try {
    const sourceFolder = path.join(from.root, record.meta.folder);
    const exists = await fsp.stat(sourceFolder).then((stat) => stat.isDirectory(), () => false);
    if (!exists) throw new LibraryError(404, 'La cartella del libro non esiste piu\' sul disco');

    await fsp.mkdir(target.root, { recursive: true });
    const folderName = await uniqueFolderName(target.root, path.basename(record.meta.folder));
    const destination = path.join(target.root, folderName);

    const hashFiles = [BOOK_JSON, ...(record.meta.sourceFile ? [record.meta.sourceFile] : [])];
    await moveFolder(sourceFolder, destination, {
      skipRename: process.env.MOVE_FORCE_COPY === '1',
      hashFiles,
    });

    // Scheda dal book.json spostato (fonte di verita'), con la nuova cartella.
    const fromDisk = await readBookJson(destination);
    const meta: BookMeta = { ...emptyMeta(), ...(fromDisk ?? record.meta), id: record.meta.id, folder: folderName };
    if (!fromDisk || folderName !== record.meta.folder) await writeBookJsonPublic(destination, meta);

    // Prima la destinazione, poi la sorgente: un'interruzione nel mezzo la sistema la scansione all'avvio.
    const targetIndex = await loadIndexFor(target);
    await saveIndexFor(target, [...targetIndex.filter((book) => book.id !== meta.id && book.folder !== folderName), meta]);
    const sourceIndex = await loadIndex();
    await saveIndex(sourceIndex.filter((book) => book.id !== bookId));
    // Per Jellyfin e' un file nuovo, in un'altra cartella.
    notifyBook(target, meta.id, 'new');
    return { to: target.id, book: meta };
  } finally {
    moving.delete(bookId);
  }
}
