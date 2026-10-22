import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './config.js';
import { currentLibrary } from './libraries.js';
import type { SeriesVolume } from '../../shared/types.js';

/** Limite di sicurezza: le voci più vecchie vengono eliminate al salvataggio. */
const MAX_CACHE_AGE = 400 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

interface CacheEntry {
  at: number;
  volumes: SeriesVolume[];
  /** true se, al momento della ricerca, non mancavano volumi noti. */
  complete?: boolean;
}

interface CacheFile {
  version: 2;
  entries: Record<string, CacheEntry>;
  /** Totale volumi indicato a mano, per chiave serie normalizzata dal client. */
  totals: Record<string, number>;
}

/** Cache e totali di una libreria, tenuti in memoria (chiave: id della libreria). */
interface LibraryState {
  file: string;
  cache: Record<string, CacheEntry>;
  totals: Record<string, number>;
}

const states = new Map<string, LibraryState>();
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Le voci della versione 1 avevano una chiave con 6 segmenti
 * (serie|autori|fonti|isbn|tipo|ao3): la nuova ne tiene solo 3 (serie|autori|tipo).
 * Se piu' voci vecchie finiscono sulla stessa chiave, vince la piu' recente.
 */
function migrateEntries(entries: Record<string, CacheEntry>): Record<string, CacheEntry> {
  const result: Record<string, CacheEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const parts = key.split('|');
    const newKey = parts.length === 6 ? `${parts[0]}|${parts[1]}|${parts[4]}` : key;
    const existing = result[newKey];
    if (!existing || (entry?.at ?? 0) > (existing.at ?? 0)) result[newKey] = entry;
  }
  return result;
}

/** Stato della libreria corrente: il file sta nella sua cartella dati. */
async function loadState(): Promise<LibraryState> {
  const library = currentLibrary();
  const known = states.get(library.id);
  if (known) return known;
  const state: LibraryState = {
    file: path.join(library.dataDir, 'series-cache.json'),
    cache: {},
    totals: {},
  };
  try {
    const raw = await fsp.readFile(state.file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheFile> & { version?: number };
    const entries =
      parsed && typeof parsed.entries === 'object' && parsed.entries !== null
        ? parsed.entries
        : {};
    state.cache = parsed?.version === 2 ? entries : migrateEntries(entries);
    if (parsed?.totals && typeof parsed.totals === 'object') {
      for (const [key, value] of Object.entries(parsed.totals)) {
        if (Number.isInteger(value) && value >= 1 && value <= 500) state.totals[key] = value;
      }
    }
  } catch {
    state.cache = {};
    state.totals = {};
  }
  // Se nel frattempo un'altra richiesta ha gia' caricato lo stato, vince il suo.
  const raced = states.get(library.id);
  if (raced) return raced;
  states.set(library.id, state);
  return state;
}

/** Toglie la cache dalla memoria (libreria eliminata). */
export function dropSeriesCache(id: string): void {
  states.delete(id);
}

/** Scrittura atomica, come per l'indice: un file temporaneo e poi il rename. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

export interface StoredSeries {
  at: number;
  volumes: SeriesVolume[];
}

/**
 * Restituisce la voce salvata solo se non ha superato `maxAgeMs`.
 * La scadenza è configurabile (Impostazioni → giorni di validità delle serie).
 */
export async function readSeriesCache(
  key: string,
  maxAgeMs: number,
): Promise<StoredSeries | null> {
  const { cache: entries } = await loadState();
  const entry = entries[key];
  if (!entry || !Number.isFinite(entry.at) || !Array.isArray(entry.volumes)) return null;
  if (Date.now() - entry.at > maxAgeMs) return null;
  return { at: entry.at, volumes: entry.volumes };
}

export async function writeSeriesCache(
  key: string,
  volumes: SeriesVolume[],
  complete = false,
): Promise<void> {
  const state = await loadState();
  state.cache[key] = { at: Date.now(), volumes, complete };

  const now = Date.now();
  const kept = Object.entries(state.cache)
    .filter(([, entry]) => Number.isFinite(entry.at) && now - entry.at <= MAX_CACHE_AGE)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_ENTRIES);
  state.cache = Object.fromEntries(kept);

  await persist(state);
}

/** Salva voci e totali insieme; lo snapshot viene preso al momento della scrittura. */
async function persist(state: LibraryState): Promise<void> {
  await queue(() => {
    const payload: CacheFile = { version: 2, entries: state.cache, totals: state.totals };
    return writeJsonAtomic(state.file, payload);
  });
}

export async function readSeriesTotals(): Promise<Record<string, number>> {
  const { totals } = await loadState();
  return { ...totals };
}

/** `null` cancella il totale. Valori ammessi: interi da 1 a 500. */
export async function writeSeriesTotal(
  key: string,
  total: number | null,
): Promise<Record<string, number>> {
  if (typeof key !== 'string' || !key || key.length > 200) {
    throw new Error('Chiave della serie non valida');
  }
  if (total !== null && (!Number.isInteger(total) || total < 1 || total > 500)) {
    throw new Error('Il totale deve essere un numero intero da 1 a 500');
  }
  const state = await loadState();
  if (total === null) delete state.totals[key];
  else state.totals[key] = total;
  await persist(state);
  return { ...state.totals };
}
