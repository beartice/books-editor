import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { parseEpub } from './metadata/epub.js';
import { toIso6391 } from './language.js';
import type { BookMeta } from '../../shared/types.js';

export interface WriteEpubResult {
  fields: string[];
  cover: boolean;
  backup: string;
}

/* ---------------- utilita' sul testo XML ---------------- */

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Valore di un attributo (con o senza prefisso, es. "opf:role") dentro la stringa degli attributi. */
function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return match ? (match[1] ?? match[2] ?? '') : undefined;
}

/**
 * Elemento XML con o senza prefisso, esteso o auto-chiuso. Gruppi: 1 nome,
 * 2 attributi, 3 contenuto (undefined se auto-chiuso). Include l'a capo che
 * precede l'elemento, cosi' le rimozioni non lasciano righe vuote.
 */
function elementRegex(name: string): RegExp {
  return new RegExp(
    `(?:\\r?\\n[ \\t]*)?<(?:[\\w-]+:)?(${name})\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?\\1\\s*>)`,
    'gi',
  );
}

interface Block {
  xml: string;
}

/**
 * Rimuove gli elementi `name` che soddisfano `pred`, con i `meta refines`
 * collegati ai loro id. Il primo elemento rimosso lascia un segnaposto, cosi'
 * i nuovi elementi finiscono nella stessa posizione.
 */
function removeElements(
  block: Block,
  name: string,
  pred: (attrs: string, content: string) => boolean,
  marker: string,
): void {
  let first = !block.xml.includes(marker);
  const ids: string[] = [];
  block.xml = block.xml.replace(elementRegex(name), (full, _n, attrs: string, content?: string) => {
    if (!pred(attrs, content ?? '')) return full;
    const id = attr(attrs, 'id');
    if (id) ids.push(id);
    if (first) {
      first = false;
      return marker;
    }
    return '';
  });
  // Rimozione a catena: un meta rimosso puo' avere a sua volta dei refines.
  while (ids.length) {
    const id = ids.pop() as string;
    block.xml = block.xml.replace(elementRegex('meta'), (full, _n, attrs: string) => {
      if (attr(attrs, 'refines') !== `#${id}`) return full;
      const own = attr(attrs, 'id');
      if (own) ids.push(own);
      return '';
    });
  }
}

/** Inserisce righe XML al posto del segnaposto, oppure in coda al blocco. */
function put(block: Block, marker: string, lines: string[]): void {
  const text = lines.map((line) => `\n    ${line}`).join('');
  if (block.xml.includes(marker)) {
    block.xml = block.xml.replace(marker, () => text);
  } else {
    block.xml = block.xml.replace(/\s*$/, (tail) => text + tail);
  }
}

function dropMarkers(block: Block): void {
  block.xml = block.xml.replace(/\u0001[a-z]+\u0001/g, '');
}

/* ---------------- immagini ---------------- */

export type ImageKind = 'jpeg' | 'png' | 'other';

export function sniffImage(data: Buffer): ImageKind {
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpeg';
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  return 'other';
}

/** Porta l'immagine nel formato richiesto, ricodificandola solo se serve. */
export async function toImageFormat(data: Buffer, target: 'jpeg' | 'png'): Promise<Buffer> {
  if (sniffImage(data) === target) return data;
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(data);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (target === 'jpeg') {
    // Il jpeg non ha trasparenza: sfondo bianco invece del nero.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, image.width, image.height);
  }
  ctx.drawImage(image, 0, 0);
  return target === 'jpeg' ? canvas.toBuffer('image/jpeg', 92) : canvas.toBuffer('image/png');
}

/* ---------------- scrittura ---------------- */

function resolveEntry(zip: AdmZip, opfDir: string, href: string) {
  const resolved = path.posix.normalize(path.posix.join(opfDir, href));
  let decoded = resolved;
  try {
    decoded = decodeURIComponent(resolved);
  } catch {
    // href con percentuali non valide: si usa il valore grezzo.
  }
  const entry = zip.getEntry(resolved) ?? zip.getEntry(decoded) ?? null;
  return { resolved: entry ? entry.entryName : decoded, entry };
}

function findOpfPath(zip: AdmZip): string {
  const container = zip.getEntry('META-INF/container.xml');
  if (container) {
    const match = /<(?:[\w-]+:)?rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(
      container.getData().toString('utf8'),
    );
    const found = match ? (match[1] ?? match[2] ?? '') : '';
    if (found) return found;
  }
  const fallback = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.opf'));
  if (!fallback) throw new Error('EPUB non valido: nessun file OPF trovato');
  return fallback.entryName;
}

export interface OpfCoverPlan {
  /** Percorso dell'immagine, relativo all'OPF (come nel manifest). */
  href: string;
  /** Formato in cui l'immagine va scritta. */
  target: 'jpeg' | 'png';
  /** true se la copertina non esisteva: il file e' nuovo e il manifest e' stato aggiornato. */
  isNew: boolean;
}

export interface RewriteOpfOptions {
  /** Campi da scrivere (title, authors, series, cover...). Senza: tutti. */
  fields?: string[];
  /** Presente se c'e' una copertina da scrivere: serve solo il formato dell'immagine di partenza. */
  cover?: { kind: ImageKind };
}

/**
 * Riscrive i metadati dentro il testo di un OPF (funzione pura: nessun file).
 * Restituisce il nuovo OPF, i campi scritti e cosa fare per la copertina.
 */
export function rewriteOpf(
  opfText: string,
  meta: BookMeta,
  options: RewriteOpfOptions = {},
): { opf: string; coverPlan: OpfCoverPlan | null; fields: string[] } {
  const isEpub3 = /<(?:[\w-]+:)?package\b[^>]*\bversion\s*=\s*["']3/i.test(opfText);

  const metaMatch = /<((?:[\w-]+:)?metadata)\b([^>]*)>([\s\S]*?)<\/\1\s*>/i.exec(opfText);
  if (!metaMatch) throw new Error('EPUB non valido: blocco metadata non trovato nell\'OPF');
  const metaTag = metaMatch[1] ?? 'metadata';
  const metaAttrs = metaMatch[2] ?? '';
  // Prefisso del namespace OPF (es. "opf:") per gli elementi meta/item.
  const prefix = metaTag.includes(':') ? metaTag.slice(0, metaTag.indexOf(':') + 1) : '';
  const block: Block = { xml: metaMatch[3] ?? '' };

  const usedIds = new Set<string>();
  for (const m of opfText.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) usedIds.add(m[1] ?? m[2] ?? '');
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };

  const fields: string[] = [];
  const want = (name: string): boolean => !options.fields || options.fields.includes(name);
  let needsOpfNs = false;
  const text = (value: string | undefined | null): string => (value ?? '').trim();

  /* ---- titolo e sottotitolo ---- */
  if (want('title') && text(meta.title)) {
    removeElements(block, 'title', () => true, '\u0001title\u0001');
    const lines: string[] = [];
    if (isEpub3) {
      const mainId = uniqueId('be-title');
      lines.push(`<dc:title id="${mainId}">${escapeXml(text(meta.title))}</dc:title>`);
      lines.push(`<${prefix}meta refines="#${mainId}" property="title-type">main</${prefix}meta>`);
      if (text(meta.subtitle)) {
        const subId = uniqueId('be-subtitle');
        lines.push(`<dc:title id="${subId}">${escapeXml(text(meta.subtitle))}</dc:title>`);
        lines.push(`<${prefix}meta refines="#${subId}" property="title-type">subtitle</${prefix}meta>`);
      }
    } else {
      lines.push(`<dc:title>${escapeXml(text(meta.title))}</dc:title>`);
      if (text(meta.subtitle)) lines.push(`<dc:title>${escapeXml(text(meta.subtitle))}</dc:title>`);
    }
    put(block, '\u0001title\u0001', lines);
    fields.push('title');
    if (text(meta.subtitle)) fields.push('subtitle');
  }

  /* ---- autori: restano gli altri ruoli (illustratore, traduttore, bkp...) ---- */
  const authors = (meta.authors ?? []).map(text).filter(Boolean);
  if (want('authors') && authors.length) {
    const roleById = new Map<string, string>();
    for (const m of block.xml.matchAll(elementRegex('meta'))) {
      const attrs = m[2] ?? '';
      const refines = attr(attrs, 'refines');
      if (refines && attr(attrs, 'property') === 'role') roleById.set(refines.replace(/^#/, ''), (m[3] ?? '').trim());
    }
    const isAuthor = (attrs: string): boolean => {
      const id = attr(attrs, 'id');
      const role = (attr(attrs, 'role') || (id ? roleById.get(id) : '') || '').trim().toLowerCase();
      return !role || role === 'aut';
    };
    removeElements(block, 'creator', (attrs) => isAuthor(attrs), '\u0001creator\u0001');
    const lines: string[] = [];
    for (const name of authors) {
      if (isEpub3) {
        const id = uniqueId('be-author');
        lines.push(`<dc:creator id="${id}">${escapeXml(name)}</dc:creator>`);
        lines.push(`<${prefix}meta refines="#${id}" property="role" scheme="marc:relators">aut</${prefix}meta>`);
      } else {
        needsOpfNs = true;
        lines.push(`<dc:creator opf:role="aut">${escapeXml(name)}</dc:creator>`);
      }
    }
    put(block, '\u0001creator\u0001', lines);
    fields.push('authors');
  }

  /* ---- campi semplici ---- */
  if (want('description') && text(meta.description)) {
    removeElements(block, 'description', () => true, '\u0001description\u0001');
    const body = escapeXml(meta.description.replace(/\r\n?/g, '\n').trim());
    put(block, '\u0001description\u0001', [`<dc:description>${body}</dc:description>`]);
    fields.push('description');
  }
  if (want('publisher') && text(meta.publisher)) {
    removeElements(block, 'publisher', () => true, '\u0001publisher\u0001');
    put(block, '\u0001publisher\u0001', [`<dc:publisher>${escapeXml(text(meta.publisher))}</dc:publisher>`]);
    fields.push('publisher');
  }
  if (want('publishedDate') && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(text(meta.publishedDate))) {
    // Le date di creazione/modifica EPUB2 (opf:event) non vengono toccate.
    removeElements(
      block,
      'date',
      (attrs) => {
        const event = (attr(attrs, 'event') ?? '').toLowerCase();
        return !event || event === 'publication';
      },
      '\u0001date\u0001',
    );
    put(block, '\u0001date\u0001', [`<dc:date>${text(meta.publishedDate)}</dc:date>`]);
    fields.push('publishedDate');
  }
  const language = text(meta.language) ? toIso6391(text(meta.language)) : undefined;
  if (want('language') && language) {
    removeElements(block, 'language', () => true, '\u0001language\u0001');
    put(block, '\u0001language\u0001', [`<dc:language>${language}</dc:language>`]);
    fields.push('language');
  }
  const tags = (meta.tags ?? []).map(text).filter(Boolean);
  if (want('tags') && tags.length) {
    removeElements(block, 'subject', () => true, '\u0001subject\u0001');
    put(block, '\u0001subject\u0001', tags.map((tag) => `<dc:subject>${escapeXml(tag)}</dc:subject>`));
    fields.push('tags');
  }

  /* ---- ISBN: gli identificatori esistenti non si toccano ---- */
  const isbnDigits = text(meta.isbn).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (want('isbn') && isbnDigits.length >= 10) {
    let present = false;
    for (const m of block.xml.matchAll(elementRegex('identifier'))) {
      if ((m[3] ?? '').replace(/[^0-9Xx]/g, '').toUpperCase().includes(isbnDigits)) present = true;
    }
    if (!present) {
      put(block, '\u0001identifier\u0001', [`<dc:identifier>urn:isbn:${isbnDigits}</dc:identifier>`]);
      fields.push('isbn');
    }
  }

  /* ---- serie (stile Calibre, in EPUB3 anche belongs-to-collection) ---- */
  if (want('series') && text(meta.series)) {
    const isSeriesMeta = (attrs: string): boolean => {
      const name = (attr(attrs, 'name') ?? '').toLowerCase();
      return (
        name === 'calibre:series' ||
        name === 'calibre:series_index' ||
        (attr(attrs, 'property') ?? '').toLowerCase() === 'belongs-to-collection'
      );
    };
    removeElements(block, 'meta', isSeriesMeta, '\u0001series\u0001');
    const index = meta.seriesIndex !== null && meta.seriesIndex !== undefined ? String(meta.seriesIndex) : '';
    const lines = [`<${prefix}meta name="calibre:series" content="${escapeXml(text(meta.series))}"/>`];
    if (index) lines.push(`<${prefix}meta name="calibre:series_index" content="${escapeXml(index)}"/>`);
    if (isEpub3) {
      const id = uniqueId('be-series');
      lines.push(`<${prefix}meta property="belongs-to-collection" id="${id}">${escapeXml(text(meta.series))}</${prefix}meta>`);
      lines.push(`<${prefix}meta refines="#${id}" property="collection-type">series</${prefix}meta>`);
      if (index) lines.push(`<${prefix}meta refines="#${id}" property="group-position">${escapeXml(index)}</${prefix}meta>`);
    }
    put(block, '\u0001series\u0001', lines);
    fields.push('series');
    if (index) fields.push('seriesIndex');
  }

  /* ---- data di modifica (solo EPUB3) ---- */
  if (isEpub3) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    let found = false;
    block.xml = block.xml.replace(elementRegex('meta'), (full, _n, attrs: string, content?: string) => {
      if (attr(attrs, 'property') !== 'dcterms:modified' || content === undefined) return full;
      found = true;
      return full.replace(/>[\s\S]*?</, () => `>${now}<`);
    });
    if (!found) {
      put(block, '\u0001modified\u0001', [`<${prefix}meta property="dcterms:modified">${now}</${prefix}meta>`]);
    }
  }

  /* ---- copertina ---- */
  let coverPlan: OpfCoverPlan | null = null;
  let manifestEdit: ((opf: string) => string) | null = null;

  if (want('cover') && options.cover) {
    const items = [...opfText.matchAll(/<(?:[\w-]+:)?item\b([^>]*?)\/?>/gi)].map((m) => m[1] ?? '');
    let coverItem = items.find((a) => (attr(a, 'properties') ?? '').split(/\s+/).includes('cover-image'));
    if (!coverItem) {
      let coverId = '';
      for (const m of block.xml.matchAll(elementRegex('meta'))) {
        if ((attr(m[2] ?? '', 'name') ?? '').toLowerCase() === 'cover') {
          coverId = attr(m[2] ?? '', 'content') ?? '';
          break;
        }
      }
      if (coverId) coverItem = items.find((a) => attr(a, 'id') === coverId);
    }
    // Alcuni EPUB fanno puntare <meta name="cover"> alla pagina XHTML di
    // copertina: sovrascriverla con un'immagine romperebbe il libro.
    if (coverItem && !(attr(coverItem, 'media-type') ?? '').toLowerCase().startsWith('image/')) {
      coverItem = undefined;
    }

    if (coverItem && attr(coverItem, 'href')) {
      // Si sostituiscono i byte mantenendo href e formato: nessun riferimento da aggiornare.
      const href = attr(coverItem, 'href') as string;
      const mediaType = (attr(coverItem, 'media-type') ?? '').toLowerCase();
      const target: 'jpeg' | 'png' =
        mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpeg' : options.cover.kind === 'png' ? 'png' : 'jpeg';
      coverPlan = { href, target, isNew: false };
      // Media-type inconsueto (gif, webp...): lo si allinea al formato scritto.
      if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') {
        const wanted = `image/${target}`;
        manifestEdit = (opf) =>
          opf.replace(/<(?:[\w-]+:)?item\b[^>]*?\/?>/gi, (tag) =>
            attr(tag, 'href') === href ? tag.replace(/(media-type\s*=\s*)(?:"[^"]*"|'[^']*')/i, `$1"${wanted}"`) : tag,
          );
      }
    } else {
      // Nessuna copertina: l'immagine va accanto all'OPF, con voce nel manifest.
      const target: 'jpeg' | 'png' = options.cover.kind === 'png' ? 'png' : 'jpeg';
      const fileName = `cover-books-editor.${target === 'png' ? 'png' : 'jpg'}`;
      const itemId = uniqueId('books-editor-cover');
      coverPlan = { href: fileName, target, isNew: true };
      removeElements(
        block,
        'meta',
        (attrs) => (attr(attrs, 'name') ?? '').toLowerCase() === 'cover',
        '\u0001cover\u0001',
      );
      put(block, '\u0001cover\u0001', [`<${prefix}meta name="cover" content="${itemId}"/>`]);
      const item = `<${prefix}item id="${itemId}" href="${fileName}" media-type="image/${target}"${
        isEpub3 ? ' properties="cover-image"' : ''
      }/>`;
      manifestEdit = (opf) => {
        const close = /(\s*)<\/(?:[\w-]+:)?manifest\s*>/i;
        if (!close.test(opf)) throw new Error('EPUB non valido: manifest non trovato nell\'OPF');
        return opf.replace(close, (_all, ws: string) => `\n    ${item}${ws}${_all.slice(ws.length)}`);
      };
    }
  }

  dropMarkers(block);

  /* ---- namespace ---- */
  let extraNs = '';
  if (!/xmlns:dc\s*=/.test(opfText)) extraNs += ' xmlns:dc="http://purl.org/dc/elements/1.1/"';
  if (needsOpfNs && !/xmlns:opf\s*=/.test(opfText)) extraNs += ' xmlns:opf="http://www.idpf.org/2007/opf"';

  let opf =
    opfText.slice(0, metaMatch.index) +
    `<${metaTag}${metaAttrs}${extraNs}>` +
    block.xml +
    `</${metaTag}>` +
    opfText.slice(metaMatch.index + metaMatch[0].length);
  if (manifestEdit) opf = manifestEdit(opf);

  return { opf, coverPlan, fields };
}

/**
 * Sovrascrive copertina e metadati dentro il file EPUB con quelli della scheda.
 * Modifica l'OPF a livello di testo (il resto del file resta identico), tiene
 * una copia dell'originale in `.backup/` e ricostruisce lo zip in modo conforme.
 */
export async function writeEpubMetadata(
  epubPath: string,
  meta: BookMeta,
  coverPath: string | null,
): Promise<WriteEpubResult> {
  const zip = new AdmZip(epubPath);
  const opfPath = findOpfPath(zip);
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB non valido: OPF non trovato (${opfPath})`);
  const opfDir = path.posix.dirname(opfPath);
  const opfText = opfEntry.getData().toString('utf8');
  const text = (value: string | undefined | null): string => (value ?? '').trim();
  const authors = (meta.authors ?? []).map(text).filter(Boolean);

  const raw = coverPath ? await fsp.readFile(coverPath).catch(() => null) : null;
  const hasCover = !!raw && raw.length > 0;
  const { opf: newOpf, coverPlan, fields } = rewriteOpf(opfText, meta, {
    cover: hasCover ? { kind: sniffImage(raw as Buffer) } : undefined,
  });
  const coverWritten = !!coverPlan;
  let newCoverEntry: { name: string; data: Buffer } | null = null;
  if (coverPlan) {
    const data = await toImageFormat(raw as Buffer, coverPlan.target);
    const name = coverPlan.isNew
      ? path.posix.normalize(path.posix.join(opfDir, coverPlan.href))
      : resolveEntry(zip, opfDir, coverPlan.href).resolved;
    newCoverEntry = { name, data };
  }

  /* ---- ricostruzione dello zip ---- */
  // noSort: adm-zip ordina le entry per nome, ma `mimetype` deve restare la prima.
  const out = new AdmZip(undefined, { noSort: true });
  out.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  const mimeEntry = out.getEntry('mimetype');
  if (mimeEntry) mimeEntry.header.method = 0;

  let coverAdded = false;
  for (const entry of zip.getEntries()) {
    if (entry.entryName === 'mimetype') continue;
    if (entry.isDirectory) {
      out.addFile(entry.entryName, Buffer.alloc(0));
      continue;
    }
    if (entry.entryName === opfEntry.entryName) {
      out.addFile(entry.entryName, Buffer.from(newOpf, 'utf8'));
    } else if (newCoverEntry && entry.entryName === newCoverEntry.name) {
      out.addFile(entry.entryName, newCoverEntry.data);
      coverAdded = true;
    } else {
      out.addFile(entry.entryName, entry.getData());
    }
  }
  if (newCoverEntry && !coverAdded) out.addFile(newCoverEntry.name, newCoverEntry.data);

  /* ---- scrittura sicura ---- */
  const folder = path.dirname(epubPath);
  const tmpPath = path.join(folder, `.${path.basename(epubPath)}.${process.pid}.tmp`);
  try {
    out.writeZip(tmpPath);
    // Si controlla il file nuovo prima di sostituire l'originale.
    const info = await parseEpub(tmpPath);
    if (fields.includes('title') && info.title !== text(meta.title)) {
      throw new Error('il titolo riletto non corrisponde');
    }
    if (fields.includes('authors') && !authors.every((name) => info.authors.includes(name))) {
      throw new Error('gli autori riletti non corrispondono');
    }
    if (coverWritten && !info.cover) throw new Error('la copertina non e\' stata trovata');
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw new Error(`Scrittura dell'EPUB annullata, file originale intatto: ${(error as Error).message}`);
  }

  // Il backup si crea una volta sola: resta sempre l'originale intatto.
  const backupDir = path.join(folder, '.backup');
  const backup = path.join(backupDir, path.basename(epubPath));
  try {
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.copyFile(epubPath, backup, fsConstants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await fsp.rename(tmpPath, epubPath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw new Error(`Scrittura dell'EPUB non riuscita: ${(error as Error).message}`);
  }

  return { fields, cover: coverWritten, backup };
}
