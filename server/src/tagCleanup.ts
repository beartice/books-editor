import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BookMeta, TagCleanupLast, TagCleanupPlan, TagCleanupSelection } from '../../shared/types.js';
import { notifyBook } from './bookEvents.js';
import { currentLibrary } from './libraries.js';
import { writeBookJsonPublic } from './library.js';
import { loadIndex, loadSettings, saveIndex } from './store.js';
import { TAG_NAME_MAX, applyToTags, planTagCleanup, selectedState } from './tagRules.js';

/*
 * Applicazione e annullamento della pulizia dei tag dei libri. Le regole (proposta,
 * sinonimi, rumore) stanno in `tagRules.ts`, che non dipende dalla libreria.
 */

export { planTagCleanup } from './tagRules.js';

/* ------------------------------------------------------------- applicazione -- */

interface BackupEntry {
  id: string;
  folder: string;
  before: string[];
  after: string[];
  /** Provenienza del campo prima della pulizia (assente = non indicata). */
  fieldSourceBefore?: string;
}

interface BackupFile {
  version: 1;
  createdAt: string;
  books: BackupEntry[];
  undoneAt?: string;
  /** Libri non ripristinati all'annullamento perche' i tag erano cambiati nel frattempo. */
  skippedOnUndo?: number;
}

const BACKUP_PREFIX = 'tag-cleanup-';

export class TagCleanupError extends Error {}

function backupsDir(): string {
  return path.join(currentLibrary().dataDir, 'backups');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function latestBackup(): Promise<{ file: string; data: BackupFile } | null> {
  let names: string[];
  try {
    names = (await fsp.readdir(backupsDir())).filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.json'));
  } catch {
    return null;
  }
  names.sort();
  const name = names[names.length - 1];
  if (!name) return null;
  try {
    const file = path.join(backupsDir(), name);
    return { file, data: JSON.parse(await fsp.readFile(file, 'utf8')) as BackupFile };
  } catch {
    return null;
  }
}

/** Ultima pulizia della libreria corrente, per mostrare «Annulla». */
export async function lastTagCleanup(): Promise<TagCleanupLast | null> {
  const last = await latestBackup();
  if (!last) return null;
  return { at: last.data.createdAt, books: last.data.books.length, undone: Boolean(last.data.undoneAt) };
}

/** Proposta per la libreria corrente, con l'ultima pulizia. */
export async function currentTagCleanupPlan(): Promise<TagCleanupPlan> {
  const plan = planTagCleanup(await loadIndex());
  plan.lastCleanup = await lastTagCleanup();
  return plan;
}

/**
 * Applica i gruppi scelti ai soli libri. La proposta si ricalcola sui dati attuali (i gruppi
 * spariti si scartano) e prima di scrivere si salva un backup dei tag. Una sola scrittura
 * dell'indice; ogni scheda cambiata viene segnalata (Jellyfin la invia con la sua coda e
 * il suo ritardo, non subito).
 */
export async function applyTagCleanup(selection: TagCleanupSelection[]): Promise<{ books: number; backup: string }> {
  for (const choice of selection) {
    if (choice.canonical !== undefined && (!choice.canonical.trim() || choice.canonical.trim().length > TAG_NAME_MAX)) {
      throw new TagCleanupError(`Il nome di un tag deve avere da 1 a ${TAG_NAME_MAX} caratteri`);
    }
  }
  const index = await loadIndex();
  const plan = planTagCleanup(index);
  const state = selectedState(selection, plan.groups);
  if (!state.used.length) throw new TagCleanupError('Nessun gruppo da applicare: la proposta è cambiata, rianalizza');

  const now = new Date().toISOString();
  const changes: { book: BookMeta; entry: BackupEntry }[] = [];
  for (const book of index) {
    if (book.kind !== 'book') continue;
    const before = book.tags ?? [];
    const after = applyToTags(before, state.removed, state.canonicals);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    changes.push({
      book,
      entry: { id: book.id, folder: book.folder, before, after, fieldSourceBefore: book.fieldSource?.tags },
    });
  }
  if (!changes.length) throw new TagCleanupError('Le scelte non cambiano nessun libro');

  // Il backup viene prima di ogni modifica.
  await fsp.mkdir(backupsDir(), { recursive: true });
  const backup = `${BACKUP_PREFIX}${now.replace(/[:.]/g, '-')}.json`;
  await writeJson(path.join(backupsDir(), backup), { version: 1, createdAt: now, books: changes.map((c) => c.entry) } satisfies BackupFile);

  await writeChanges(changes.map(({ book, entry }) => ({ book, tags: entry.after, source: 'manual' })), now);
  return { books: changes.length, backup };
}

/**
 * Scrive i nuovi tag di molti libri: `book.json` di ciascuno, un solo salvataggio dell'indice.
 * `source` e' la provenienza del campo (`manual`: un «Metadati online» futuro non lo sovrascrive
 * in automatico); `undefined` la toglie (annullamento di una provenienza assente).
 */
async function writeChanges(
  changes: { book: BookMeta; tags: string[]; source: string | undefined }[],
  now: string,
): Promise<void> {
  const settings = await loadSettings();
  const index = await loadIndex();
  const byId = new Map(index.map((book) => [book.id, book]));
  const library = currentLibrary();
  for (const change of changes) {
    const current = byId.get(change.book.id);
    if (!current) continue;
    const fieldSource = { ...current.fieldSource };
    if (change.source === undefined) delete fieldSource.tags;
    else fieldSource.tags = change.source;
    const next: BookMeta = { ...current, tags: change.tags, fieldSource, dateModified: now };
    await writeBookJsonPublic(path.join(settings.libraryRoot, current.folder), next);
    byId.set(next.id, next);
  }
  await saveIndex(index.map((book) => byId.get(book.id) ?? book));
  for (const change of changes) notifyBook(library, change.book.id, 'changed');
}

/** Annulla l'ultima pulizia: ripristina i tag solo dei libri non cambiati dopo. */
export async function undoLastTagCleanup(): Promise<{ restored: number; skipped: number }> {
  const last = await latestBackup();
  if (!last || last.data.undoneAt) throw new TagCleanupError('Nessuna pulizia da annullare');
  const index = await loadIndex();
  const byId = new Map(index.map((book) => [book.id, book]));
  const changes: { book: BookMeta; tags: string[]; source: string | undefined }[] = [];
  let skipped = 0;
  for (const entry of last.data.books) {
    const book = byId.get(entry.id);
    if (!book || JSON.stringify(book.tags ?? []) !== JSON.stringify(entry.after)) {
      skipped += 1;
      continue;
    }
    changes.push({ book, tags: entry.before, source: entry.fieldSourceBefore });
  }
  if (changes.length) await writeChanges(changes, new Date().toISOString());
  await writeJson(last.file, { ...last.data, undoneAt: new Date().toISOString(), skippedOnUndo: skipped });
  return { restored: changes.length, skipped };
}
