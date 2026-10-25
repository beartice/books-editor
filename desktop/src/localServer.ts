import { app } from 'electron';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// Server di books-editor dentro l'app (modalita' locale).
//
// Gira in un processo separato: un blocco o un errore del server non ferma l'interfaccia.
// Si avvia con child_process.fork sull'eseguibile dell'app con ELECTRON_RUN_AS_NODE=1, cioe'
// come un normale Node. Ho scartato utilityProcess perche' vi gira `process.type === 'utility'`
// e pdf.js (letture dei PDF) lo scambia per un browser, pretendendo un worker che non c'e'.
// Se l'app muore di colpo il canale IPC si chiude e il launcher del server esce da solo.

const PREFERRED_PORT = 47821;
const START_TIMEOUT_MS = 40_000;
const LOG_TAIL_LINES = 40;

export interface LocalServer {
  /** Origine del server, ad esempio `http://127.0.0.1:47821`. */
  origin: string;
  /** Token da mettere nel cookie `be_desktop` della finestra. */
  token: string;
}

let child: ChildProcess | null = null;
let stopping = false;
let tail: string[] = [];

/** Cartella del server impacchettato (in sviluppo: `desktop/server-dist`, creata da `npm run build`). */
function serverDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '..', 'server-dist');
}

/** Cartella dei dati del server (indice, impostazioni) e delle librerie aggiuntive. */
export function dataDirs(): { data: string; libraries: string; log: string } {
  const userData = app.getPath('userData');
  return {
    data: path.join(userData, 'data'),
    libraries: path.join(userData, 'librerie'),
    log: path.join(userData, 'logs', 'server.log'),
  };
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1' }, () => probe.close(() => resolve(true)));
  });
}

/** Porta libera: prima quella usata l'ultima volta (origine stabile), poi una a caso assegnata dal sistema. */
async function pickPort(preferred: number | null): Promise<number> {
  for (const port of [preferred, PREFERRED_PORT]) {
    if (port && (await canListen(port))) return port;
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Prepara `settings.json` se manca, con la cartella scelta dalla persona. Se c'e' gia' vale quello
 * (la cartella si puo' cambiare dalle Impostazioni). Non si usa LIBRARY_ROOT: bloccherebbe quel campo.
 */
function ensureSettings(dataDir: string, libraryRoot: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(libraryRoot, { recursive: true });
  const file = path.join(dataDir, 'settings.json');
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, JSON.stringify({ libraryRoot }, null, 2));
}

/** Ultime righe di log del server, per il messaggio d'errore. */
export function lastServerLog(): string {
  return tail.join('\n').trim();
}

async function waitHealthy(origin: string, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('Il server si e\' fermato durante l\'avvio');
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      /* non ancora pronto */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Il server non ha risposto entro il tempo previsto');
}

/** Avvia il server e attende `/api/health`. `onExit` e' chiamata se il server muore dopo l'avvio. */
export async function startLocalServer(
  libraryRoot: string,
  preferredPort: number | null,
  onExit: (code: number | string) => void,
): Promise<LocalServer & { port: number }> {
  await stopLocalServer();
  const dirs = dataDirs();
  ensureSettings(dirs.data, libraryRoot);
  fs.mkdirSync(path.dirname(dirs.log), { recursive: true });

  const entry = path.join(serverDir(), 'launcher.cjs');
  if (!fs.existsSync(entry)) throw new Error(`Server non trovato (${entry}): rifai la build dell'app`);

  const port = await pickPort(preferredPort);
  const token = crypto.randomBytes(32).toString('hex');
  const origin = `http://127.0.0.1:${port}`;

  // Ambiente pulito dalle variabili che cambierebbero il comportamento del server.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(AUTH_|LIBRARY_ROOT$|TRUST_PROXY$|CORS_ORIGINS$|IMPORT_ROOTS$|SESSION_|ELECTRON_RUN_AS_NODE$)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dirs.data,
    // Le librerie aggiuntive stanno nei dati dell'app: nessuna cartella in piu' accanto ai libri.
    LIBRARIES_ROOT: dirs.libraries,
    WEB_DIST: path.join(serverDir(), 'web'),
    DESKTOP_TOKEN: token,
    ELECTRON_RUN_AS_NODE: '1',
  });

  tail = [];
  stopping = false;
  const log = fs.createWriteStream(dirs.log, { flags: 'w' });
  const proc = fork(entry, [], {
    env,
    cwd: serverDir(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child = proc;
  let exited = false;
  const collect = (chunk: Buffer) => {
    log.write(chunk);
    tail.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    if (tail.length > LOG_TAIL_LINES) tail = tail.slice(-LOG_TAIL_LINES);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);
  let ready = false;
  proc.once('error', (error) => collect(Buffer.from(`${error.message}\n`)));
  proc.once('exit', (code, signal) => {
    exited = true;
    log.end();
    if (child === proc) child = null;
    if (ready && !stopping) onExit(code ?? signal ?? 'sconosciuto');
  });

  try {
    await waitHealthy(origin, () => exited);
  } catch (error) {
    await stopLocalServer();
    throw error;
  }
  ready = true;
  return { origin, token, port };
}

/** Ferma il server e attende che il processo sia finito (al massimo qualche secondo). */
export async function stopLocalServer(): Promise<void> {
  const proc = child;
  if (!proc) return;
  stopping = true;
  child = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 4000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    if (proc.exitCode !== null || !proc.kill()) {
      clearTimeout(timer);
      resolve();
    }
  });
}
