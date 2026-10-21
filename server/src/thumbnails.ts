import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, ensureDir } from './config.js';

/* Miniature delle copertine: generate al primo uso e tenute su disco. */

const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const MAX_PARALLEL = 4;

export interface Thumbnail {
  data: Buffer;
  type: string;
}

// Richieste contemporanee per la stessa chiave condividono la stessa Promise.
const inFlight = new Map<string, Promise<Thumbnail | null>>();
// Chiavi per cui si serve l'originale (gia' piccolo o illeggibile): non si ridecodifica.
const useOriginal = new Set<string>();

// Semaforo semplice: al massimo MAX_PARALLEL generazioni insieme.
let running = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // il posto passa direttamente al prossimo in coda
  else running -= 1;
}

async function removeByPrefix(prefix: string): Promise<void> {
  try {
    const names = await fsp.readdir(THUMBS_DIR);
    await Promise.all(
      names
        .filter((name) => name.startsWith(prefix))
        .map((name) => fsp.rm(path.join(THUMBS_DIR, name), { force: true }).catch(() => undefined)),
    );
  } catch {
    /* cartella assente o illeggibile: niente da pulire */
  }
}

/** Cancella tutte le miniature di un libro (da chiamare quando il libro viene eliminato). */
export async function removeCoverThumbnails(id: string): Promise<void> {
  await removeByPrefix(`${id}-`);
}

async function generate(
  id: string,
  coverPath: string,
  width: number,
  file: string,
  originalSize: number,
): Promise<Thumbnail | null> {
  await acquire();
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(await fsp.readFile(coverPath));
    // Non si ingrandisce: l'originale piccolo viene servito com'e'.
    if (!image.width || image.width <= width) return null;
    const height = Math.max(1, Math.round((image.height * width) / image.width));
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    const data = await canvas.encode('webp', 80);
    if (data.length >= originalSize) return null;
    ensureDir(THUMBS_DIR);
    await removeByPrefix(`${id}-${width}-`);
    // Scrittura atomica: non si serve mai un file a meta'.
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
    return { data, type: 'image/webp' };
  } catch {
    // Immagine non decodificabile: il chiamante servira' l'originale.
    return null;
  } finally {
    release();
  }
}

/**
 * Miniatura WebP di larghezza `width`, oppure null se conviene servire l'originale
 * (gia' piccolo, miniatura piu' pesante, file illeggibile).
 */
export async function getCoverThumbnail(
  id: string,
  coverPath: string,
  width: number,
): Promise<Thumbnail | null> {
  const stat = await fsp.stat(coverPath).catch(() => null);
  if (!stat) return null;
  const hash = crypto
    .createHash('sha1')
    .update(`${coverPath}|${stat.mtimeMs}|${stat.size}`)
    .digest('hex')
    .slice(0, 12);
  const file = path.join(THUMBS_DIR, `${id}-${width}-${hash}.webp`);

  if (useOriginal.has(file)) return null;
  const cached = await fsp.readFile(file).catch(() => null);
  if (cached) return { data: cached, type: 'image/webp' };

  let pending = inFlight.get(file);
  if (!pending) {
    pending = generate(id, coverPath, width, file, stat.size)
      .then((thumb) => {
        if (!thumb) useOriginal.add(file);
        return thumb;
      })
      .finally(() => inFlight.delete(file));
    inFlight.set(file, pending);
  }
  return pending;
}
