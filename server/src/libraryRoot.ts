import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/** true se `child` coincide con `parent` o sta al suo interno. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realOrSame(target: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch {
    return target;
  }
}

/**
 * Convalida e prepara la cartella della libreria scelta dall'utente: espande `~`,
 * richiede un percorso assoluto, esclude la radice e la cartella dei dati, crea la
 * cartella e verifica che sia scrivibile. Restituisce il percorso risolto.
 */
export async function prepareLibraryRoot(input: string): Promise<{ path: string } | { error: string }> {
  let raw = input.trim();
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1));
  }
  if (!raw || !path.isAbsolute(raw)) {
    return { error: 'Indica un percorso completo (es. /Users/nome/Libri)' };
  }
  const root = path.resolve(raw);
  if (path.parse(root).root === root) {
    return { error: 'Non puoi usare la radice del disco come cartella della libreria' };
  }

  const conflict = 'La cartella della libreria non puo\' coincidere con la cartella dei dati dell\'app, ne\' contenerla o stare al suo interno';
  const clash = (a: string, b: string) => isInside(a, b) || isInside(b, a);
  if (clash(root, DATA_DIR)) return { error: conflict };

  try {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) return { error: 'Il percorso indicato e\' un file, non una cartella' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { error: `Impossibile leggere la cartella: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
    }
  }

  try {
    await fsp.mkdir(root, { recursive: true });
    const probe = path.join(root, `.write-test-${crypto.randomBytes(6).toString('hex')}`);
    await fsp.writeFile(probe, '');
    await fsp.rm(probe, { force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: `Impossibile scrivere nella cartella: ${code ?? (error as Error).message}` };
  }

  // Ora la cartella esiste: si confrontano anche i percorsi reali (link simbolici).
  if (clash(await realOrSame(root), await realOrSame(DATA_DIR))) return { error: conflict };
  return { path: root };
}
