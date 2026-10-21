import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, ensureDir } from './config.js';
import type { SeriesVolume } from '../../shared/types.js';

const CACHE_FILE = path.join(DATA_DIR, 'series-cache.json');
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

let cache: Record<string, CacheEntry> | null = null;
let totals: Record<string, number> = {};
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

async function loadCache(): Promise<Record<string, CacheEntry>> {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheFile> & { version?: number };
    const entries =
      parsed && typeof parsed.entries === 'object' && parsed.entries !== null
        ? parsed.entries
        : {};
    cache = parsed?.version === 2 ? entries : migrateEntries(entries);
    totals = {};
    if (parsed?.totals && typeof parsed.totals === 'object') {
      for (const [key, value] of Object.entries(parsed.totals)) {
        if (Number.isInteger(value) && value >= 1 && value <= 500) totals[key] = value;
      }
    }
  } catch {
    cache = {};
    totals = {};
  }
  return cache;
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
  const entries = await loadCache();
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
  const entries = await loadCache();
  entries[key] = { at: Date.now(), volumes, complete };

  const now = Date.now();
  const kept = Object.entries(entries)
    .filter(([, entry]) => Number.isFinite(entry.at) && now - entry.at <= MAX_CACHE_AGE)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_ENTRIES);
  cache = Object.fromEntries(kept);

  await persist();
}

/** Salva voci e totali insieme; lo snapshot viene preso al momento della scrittura. */
async function persist(): Promise<void> {
  await queue(() => {
    const payload: CacheFile = { version: 2, entries: cache ?? {}, totals };
    return writeJsonAtomic(CACHE_FILE, payload);
  });
}

export async function readSeriesTotals(): Promise<Record<string, number>> {
  await loadCache();
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
  await loadCache();
  if (total === null) delete totals[key];
  else totals[key] = total;
  await persist();
  return { ...totals };
}
