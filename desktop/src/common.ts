import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Risposta dei metodi del ponte: gli errori viaggiano come dati, l'IPC ne perderebbe i dettagli. */
export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'running' | 'failed'; message: string };

const configFile = (): string => path.join(app.getPath('userData'), 'config.json');

/** Modalita' dell'app: server di books-editor dentro l'app, oppure client di un server remoto. */
export type Mode = 'local' | 'server';

/** Contenuto di `config.json` nella cartella dei dati dell'app. */
export interface AppConfig {
  mode: Mode | null;
  serverUrl: string | null;
  /** Cartella della libreria scelta al primo avvio (poi vale `settings.json` del server). */
  libraryRoot: string | null;
  /** Ultima porta usata dal server locale: tenerla stabile conserva i dati del sito (localStorage). */
  localPort: number | null;
}

/**
 * Legge la configurazione. Un `config.json` delle versioni precedenti ha solo `serverUrl`
 * e resta in modalita' server, senza domande; senza nulla (primo avvio) la modalita' e' null.
 */
export function readConfig(): AppConfig {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Record<string, unknown>;
  } catch {
    /* assente o illeggibile: primo avvio */
  }
  const serverUrl = typeof data.serverUrl === 'string' ? normalizeServerUrl(data.serverUrl) : null;
  const libraryRoot = typeof data.libraryRoot === 'string' && path.isAbsolute(data.libraryRoot) ? data.libraryRoot : null;
  const port = Number(data.localPort);
  const mode: Mode | null = data.mode === 'local' && libraryRoot ? 'local' : serverUrl ? 'server' : null;
  return {
    mode,
    serverUrl,
    libraryRoot,
    localPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null,
  };
}

/** Aggiorna alcuni campi di `config.json`, lasciando gli altri come sono. */
export function updateConfig(patch: Partial<AppConfig>): void {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
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
