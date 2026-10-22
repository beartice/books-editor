import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AppleAnnotationRow,
  AppleBooksRawData,
  AppleLibraryRow,
} from '../../shared/types.js';

// Lettura dei database di Apple Books: nessuna dipendenza da store/library, cosi'
// il modulo e' usabile anche dall'app per Mac.
export type { AppleAnnotationRow as AnnotationRow, AppleLibraryRow };

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

/**
 * Cartelle `Data/Documents` candidate. `APPLE_BOOKS_CONTAINER` può puntare al
 * container oppure alla cartella Documents (utile per i backup).
 */
export function documentsCandidates(): string[] {
  const candidates: string[] = [];
  const configured = process.env.APPLE_BOOKS_CONTAINER?.trim();
  if (configured) {
    const root = expandHome(configured);
    candidates.push(path.join(root, 'Data', 'Documents'));
    candidates.push(root);
    candidates.push(path.join(root, 'Documents'));
  }
  candidates.push(
    path.join(os.homedir(), 'Library/Containers/com.apple.iBooksX/Data/Documents'),
  );
  return [...new Set(candidates)];
}

async function findDatabase(dir: string, pattern: RegExp): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const files = entries.filter(
    (name) => pattern.test(name) && !name.endsWith('-wal') && !name.endsWith('-shm'),
  );
  if (!files.length) return null;
  const stats = await Promise.all(
    files.map(async (name) => {
      const file = path.join(dir, name);
      const stat = await fsp.stat(file).catch(() => null);
      return { file, at: stat?.mtimeMs ?? 0 };
    }),
  );
  stats.sort((a, b) => b.at - a.at);
  return stats[0].file;
}

export async function locateDatabases(): Promise<{ annotations: string; library: string | null }> {
  for (const docs of documentsCandidates()) {
    const annotations = await findDatabase(
      path.join(docs, 'AEAnnotation'),
      /^AEAnnotation.*\.sqlite$/i,
    );
    if (!annotations) continue;
    const library = await findDatabase(
      path.join(docs, 'BKLibrary'),
      /^BKLibrary.*\.sqlite$/i,
    );
    return { annotations, library };
  }
  throw new Error(
    'Database di Apple Books non trovato. Apri Libri sul Mac almeno una volta, ' +
      'oppure imposta APPLE_BOOKS_CONTAINER sulla cartella del container (anche di un backup).',
  );
}

export async function sqliteJson<T>(database: string, sql: string): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      ['-json', '-readonly', database, sql],
      { maxBuffer: MAX_BUFFER },
    );
    const text = stdout.trim();
    if (!text) return [];
    return JSON.parse(text) as T[];
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        'Il comando sqlite3 non è disponibile. Su macOS è incluso nel sistema; ' +
          'negli altri ambienti l’importazione di Apple Books non è supportata.',
      );
    }
    const detail = err.stderr?.trim() || err.message;
    throw new Error(`Lettura del database Apple Books non riuscita: ${detail}`);
  }
}

export async function readAnnotations(database: string): Promise<AppleAnnotationRow[]> {
  const rows = await sqliteJson<AppleAnnotationRow>(
    database,
    `SELECT
       ZANNOTATIONUUID AS uuid,
       ZANNOTATIONASSETID AS assetId,
       ZANNOTATIONSELECTEDTEXT AS text,
       ZANNOTATIONNOTE AS note,
       ZANNOTATIONLOCATION AS location,
       ZANNOTATIONSTYLE AS style,
       ZANNOTATIONISUNDERLINE AS underline,
       ZANNOTATIONCREATIONDATE AS createdAt,
       ZANNOTATIONMODIFICATIONDATE AS modifiedAt
     FROM ZAEANNOTATION
     WHERE ZANNOTATIONDELETED = 0
       AND trim(COALESCE(ZANNOTATIONSELECTEDTEXT, '')) <> ''`,
  );
  return rows;
}

export async function readLibrary(database: string | null): Promise<AppleLibraryRow[]> {
  if (!database) return [];
  const rows = await sqliteJson<AppleLibraryRow>(
    database,
    `SELECT
       ZASSETID AS assetId,
       ZTITLE AS title,
       ZSORTTITLE AS sortTitle,
       ZAUTHOR AS author,
       ZSORTAUTHOR AS sortAuthor,
       ZDATEFINISHED AS finishedAt,
       ZREADINGPROGRESS AS readingProgress
     FROM ZBKLIBRARYASSET
     WHERE ZASSETID IS NOT NULL`,
  );
  return rows.filter((row) => String(row.assetId ?? '').trim());
}

/** Legge annotazioni e libreria di Apple Books dal Mac (o da una copia in APPLE_BOOKS_CONTAINER). */
export async function readAppleBooksData(): Promise<AppleBooksRawData> {
  if (process.platform !== 'darwin' && !process.env.APPLE_BOOKS_CONTAINER) {
    throw new Error('L’importazione da Apple Books è disponibile solo su macOS.');
  }
  const { annotations: annotationDb, library: libraryDb } = await locateDatabases();
  const [annotations, library] = await Promise.all([
    readAnnotations(annotationDb),
    readLibrary(libraryDb),
  ]);
  return { database: annotationDb, annotations, library };
}
