import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Risposta dei metodi del ponte: gli errori viaggiano come dati, l'IPC ne perderebbe i dettagli. */
export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'running' | 'failed'; message: string };

const configFile = (): string => path.join(app.getPath('userData'), 'config.json');

/** Indirizzo del server salvato (solo l'origine), o null al primo avvio. */
export function readServerUrl(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as { serverUrl?: unknown };
    return typeof data.serverUrl === 'string' ? normalizeServerUrl(data.serverUrl) : null;
  } catch {
    return null;
  }
}

export function writeServerUrl(serverUrl: string): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ serverUrl }, null, 2));
}

/** Accetta solo http(s) e restituisce l'origine (senza percorso); null se non valido. */
export function normalizeServerUrl(input: string): string | null {
  const text = input.trim();
  if (!text || text.length > 300) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Dice se un URL appartiene all'origine indicata. */
export function sameOrigin(url: string | undefined, origin: string | null): boolean {
  if (!url || !origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
