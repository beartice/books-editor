import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ConversionSupport } from '../../shared/types.js';

/* Conversione dei formati che l'app non legge (MOBI, AZW3, FB2, DJVU...) in
   EPUB o PDF. Usa Calibre (`ebook-convert`) e djvulibre (`ddjvu`, `djvutxt`). */

/** Estensioni che si convertono all'import. Non vanno in MEDIA_EXTENSIONS: la scansione le ignora. */
export const CONVERTIBLE_EXTENSIONS = ['.mobi', '.prc', '.azw', '.azw3', '.fb2', '.djvu', '.djv'] as const;
const DJVU_EXTENSIONS = new Set(['.djvu', '.djv']);

/** Un DJVU con meno di tanti caratteri di testo (in tutto) e' una scansione. */
const MIN_DJVU_CHARS = 200;
/** ...oppure con meno di tanti caratteri per pagina in media. */
const MIN_DJVU_CHARS_PER_PAGE = 20;

const CALIBRE_MAC_DIR = '/Applications/calibre.app/Contents/MacOS';

/** Cartelle standard degli strumenti su Windows (non sono nel PATH dopo l'installazione). */
function windowsToolDirs(name: string): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']
    .filter((dir): dir is string => Boolean(dir));
  const folders = name === 'ebook-convert' ? ['Calibre2'] : ['DjVuLibre', 'DjVuLibre\\bin'];
  return [...new Set(roots.flatMap((root) => folders.map((folder) => path.join(root, folder))))];
}

/** Errore di conversione con un messaggio adatto all'utente (i dettagli vanno nel log). */
export class ConversionError extends Error {}

export interface ConversionResult {
  outputPath: string;
  format: 'epub' | 'pdf';
  /** Strumento usato: `ebook-convert`, `ddjvu`. */
  method: string;
}

export function isConvertible(filePath: string): boolean {
  return (CONVERTIBLE_EXTENSIONS as readonly string[]).includes(path.extname(filePath).toLowerCase());
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const TOOL_ENV: Record<string, string> = {
  'ebook-convert': 'EBOOK_CONVERT',
  ddjvu: 'DDJVU',
  djvutxt: 'DJVUTXT',
  djvused: 'DJVUSED',
};

/**
 * Percorso di uno strumento: la variabile d'ambiente dedicata (se punta a un
 * eseguibile), poi il PATH e, per Calibre, l'app del Mac. `null` se manca.
 */
export function findTool(name: 'ebook-convert' | 'ddjvu' | 'djvutxt' | 'djvused'): string | null {
  const override = process.env[TOOL_ENV[name]]?.trim();
  if (override) return isExecutable(override) ? override : null;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (name === 'ebook-convert') dirs.push(CALIBRE_MAC_DIR);
  if (process.platform === 'win32') dirs.push(...windowsToolDirs(name));
  // Su Windows gli eseguibili hanno l'estensione .exe.
  const fileNames = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const dir of dirs) {
    for (const fileName of fileNames) {
      const candidate = path.join(dir, fileName);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Cosa si puo' convertire con gli strumenti installati. */
export function conversionSupport(): ConversionSupport {
  const calibre = Boolean(findTool('ebook-convert'));
  // Un DJVU con testo passa da Calibre (che usa djvutxt), una scansione da ddjvu.
  const djvu = Boolean(findTool('ddjvu')) || (calibre && Boolean(findTool('djvutxt')));
  const extensions = CONVERTIBLE_EXTENSIONS.filter((ext) =>
    DJVU_EXTENSIONS.has(ext) ? djvu : calibre,
  );
  return { calibre, djvu, extensions };
}

const MISSING_TOOLS = 'Conversione non disponibile: sul server mancano Calibre o djvulibre';

/** Tempo massimo di una conversione (CONVERT_TIMEOUT_SEC, default 10 minuti). */
function timeoutMs(): number {
  const seconds = Number(process.env.CONVERT_TIMEOUT_SEC);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 10 * 60 * 1000;
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/** Esegue uno strumento senza shell, con ambiente controllato. Mappa gli errori in ConversionError. */
function run(tool: string, args: string[], workDir: string, maxBuffer = 64 * 1024 * 1024): Promise<RunResult> {
  const home = path.join(workDir, 'home');
  const tmp = path.join(workDir, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  // Calibre trova djvutxt dal PATH: ci mettiamo anche la cartella dello strumento scelto.
  const toolDirs = ['djvutxt', 'ddjvu', 'djvused']
    .map((name) => findTool(name as 'djvutxt'))
    .filter((p): p is string => Boolean(p))
    .map((p) => path.dirname(p));
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set([...toolDirs, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)])].join(
      path.delimiter,
    ),
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: home,
    TMPDIR: tmp,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CALIBRE_CONFIG_DIRECTORY: path.join(home, 'calibre-config'),
    CALIBRE_CACHE_DIRECTORY: path.join(home, 'calibre-cache'),
    CALIBRE_TEMP_DIR: tmp,
    QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen',
  };
  if (process.platform === 'win32') {
    // Gli strumenti di Windows hanno bisogno della cartella di sistema e di profilo/temporanei propri.
    Object.assign(env, {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      TEMP: tmp,
      TMP: tmp,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    });
  }
  return new Promise((resolve, reject) => {
    execFile(
      tool,
      args,
      { env, cwd: workDir, timeout: timeoutMs(), killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // Il dettaglio completo resta nel log del server, non va all'utente.
        console.warn(`Conversione: ${path.basename(tool)} non riuscito (${err.code ?? err.signal ?? 'errore'})\n${stderr || stdout}`);
        if (err.code === 'ENOENT') return reject(new ConversionError(MISSING_TOOLS));
        if (err.killed || err.signal === 'SIGKILL' || err.signal === 'SIGTERM') {
          return reject(new ConversionError('La conversione ha impiegato troppo tempo'));
        }
        if (/DRMError|\bDRM\b/i.test(`${stderr}\n${stdout}`)) {
          return reject(new ConversionError('Il file e\' protetto da DRM e non si puo\' convertire'));
        }
        reject(new ConversionError('Conversione non riuscita: il file potrebbe essere danneggiato o in un formato non valido'));
      },
    );
  });
}

/** Caratteri di testo (spazi esclusi) del livello di testo di un DJVU e pagine, se note. */
async function measureDjvuText(input: string, workDir: string): Promise<{ chars: number; pages: number | null }> {
  const djvutxt = findTool('djvutxt');
  if (!djvutxt) return { chars: 0, pages: null };
  let chars = 0;
  try {
    const { stdout } = await run(djvutxt, [input], workDir, 256 * 1024 * 1024);
    chars = stdout.replace(/\s+/g, '').length;
  } catch (error) {
    // Un errore di timeout o di strumento non va nascosto; un file illeggibile vale «senza testo».
    if (error instanceof ConversionError && /troppo tempo|mancano/.test(error.message)) throw error;
  }
  let pages: number | null = null;
  const djvused = findTool('djvused');
  if (djvused) {
    try {
      const { stdout } = await run(djvused, ['-e', 'n', input], workDir);
      const count = Number(stdout.trim());
      if (Number.isInteger(count) && count > 0) pages = count;
    } catch {
      pages = null;
    }
  }
  return { chars, pages };
}

async function checkOutput(file: string, format: 'epub' | 'pdf'): Promise<void> {
  const bad = new ConversionError('Conversione non riuscita: il file prodotto non e\' valido');
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw bad;
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(5);
    await handle.read(head, 0, 5, 0);
    const ok = format === 'epub' ? head.subarray(0, 2).toString('latin1') === 'PK' : head.toString('latin1') === '%PDF-';
    if (!ok) throw bad;
  } finally {
    await handle.close();
  }
}

/* Una conversione alla volta: Calibre usa molta memoria. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

/**
 * Converte un file in un formato che l'app legge: EPUB (MOBI, AZW, FB2, DJVU con
 * testo) o PDF (DJVU di sole immagini). Il risultato sta in `workDir`, che il
 * chiamante crea e cancella.
 */
export function convertToReadable(inputPath: string, workDir: string): Promise<ConversionResult> {
  return exclusive(async () => {
    const ext = path.extname(inputPath).toLowerCase();
    if (!isConvertible(inputPath)) throw new ConversionError('Formato non convertibile');
    const stem = path.basename(inputPath, path.extname(inputPath));
    const outDir = path.join(workDir, 'out');
    await fsp.mkdir(outDir, { recursive: true });

    let scan = false;
    if (DJVU_EXTENSIONS.has(ext)) {
      if (!conversionSupport().djvu) throw new ConversionError(MISSING_TOOLS);
      const { chars, pages } = await measureDjvuText(inputPath, workDir);
      scan = chars < MIN_DJVU_CHARS || (pages != null && chars / pages < MIN_DJVU_CHARS_PER_PAGE);
      // Senza Calibre anche un DJVU con testo si puo' tenere solo come PDF di immagini.
      if (!scan && !findTool('ebook-convert')) scan = true;
    }

    if (scan) {
      const ddjvu = findTool('ddjvu');
      if (!ddjvu) throw new ConversionError(MISSING_TOOLS);
      const output = path.join(outDir, `${stem}.pdf`);
      await run(ddjvu, ['-format=pdf', '-quality=85', inputPath, output], workDir);
      await checkOutput(output, 'pdf');
      return { outputPath: output, format: 'pdf', method: 'ddjvu' } satisfies ConversionResult;
    }

    const calibre = findTool('ebook-convert');
    if (!calibre) throw new ConversionError(MISSING_TOOLS);
    const output = path.join(outDir, `${stem}.epub`);
    await run(calibre, [inputPath, output], workDir);
    await checkOutput(output, 'epub');
    return { outputPath: output, format: 'epub', method: 'ebook-convert' } satisfies ConversionResult;
  });
}
