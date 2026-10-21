import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

export interface ExtractedCover {
  data: Buffer;
  ext: string;
}

export interface EpubInfo {
  title: string;
  subtitle: string;
  authors: string[];
  language: string;
  publisher: string;
  publishedDate: string;
  isbn: string;
  identifiers: Record<string, string>;
  description: string;
  subjects: string[];
  series: string;
  seriesIndex: number | null;
  cover: ExtractedCover | null;
  wordCount: number;
  charCount: number;
  chapters: number;
  /** Testo iniziale: serve a individuare i metadati inline delle fanfic. */
  headText: string;
  /** Porzione di testo che contiene i metadati, se individuata. */
  infoText: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Con l'impostazione predefinita fast-xml-parser si ferma dopo 1000 entita'
  // per documento, contando anche &quot; e &amp;: gli OPF di Calibre ne hanno
  // migliaia (metadati utente in JSON dentro gli attributi). Il conteggio
  // totale si alza; restano stretti i limiti sulle entita' definite nel
  // DOCTYPE, che sono quelle degli attacchi "billion laughs".
  processEntities: {
    enabled: true,
    maxTotalExpansions: 1_000_000,
    maxEntityCount: 100,
    maxEntitySize: 10_000,
    maxExpansionDepth: 10,
    maxExpandedLength: 100_000,
  },
  isArray: (name) =>
    [
      'title',
      'creator',
      'contributor',
      'identifier',
      'subject',
      'language',
      'publisher',
      'date',
      'description',
      'meta',
      'item',
      'itemref',
    ].includes(name),
});

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  szlig: 'ß',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const known = ENTITIES[entity.toLowerCase()];
    return known ?? match;
  });
}

/** Rimuove tag e script/style, poi normalizza gli spazi. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|dt|dd|blockquote|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return matches ? matches.length : 0;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text'] ?? '');
  }
  return value === undefined || value === null ? '' : String(value);
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return '';
}

const INFO_FILE_HINTS = [
  'about',
  'info',
  'metadata',
  'frontmatter',
  'preface',
  'summary',
  'notes',
  'credits',
  'toc',
  'cover',
  'title',
  'start',
];

function looksLikeInfoPage(name: string): boolean {
  const base = path.basename(name).toLowerCase();
  return INFO_FILE_HINTS.some((hint) => base.includes(hint));
}

/**
 * Estrae metadati, copertina e statistiche da un file EPUB.
 */
/**
 * Un EPUB e' un archivio ZIP (inizia con "PK"). Download falliti salvano spesso
 * una pagina web con estensione .epub: meglio dirlo chiaramente invece di
 * mostrare l'errore tecnico della libreria zip.
 */
async function assertZip(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(512), 0, 512, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head[0] === 0x50 && head[1] === 0x4b) return;
    const text = head.toString('utf8').trimStart().toLowerCase();
    if (text.startsWith('<!doctype html') || text.startsWith('<html') || text.includes('<head')) {
      throw new Error(
        'Il file non e\' un EPUB ma una pagina web (HTML) salvata con estensione .epub: probabilmente il download non e\' andato a buon fine',
      );
    }
    throw new Error('Il file non e\' un EPUB valido (non e\' un archivio ZIP): potrebbe essere danneggiato o incompleto');
  } finally {
    await handle.close();
  }
}

export async function parseEpub(filePath: string): Promise<EpubInfo> {
  await assertZip(filePath);
  const zip = new AdmZip(filePath);

  const containerEntry = zip.getEntry('META-INF/container.xml');
  let opfPath = '';
  if (containerEntry) {
    const container = xmlParser.parse(containerEntry.getData().toString('utf8')) as Record<string, any>;
    const roots = asArray(container?.container?.rootfiles?.rootfile);
    opfPath = roots[0]?.['@full-path'] ?? '';
  }
  if (!opfPath) {
    const fallback = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.opf'));
    opfPath = fallback?.entryName ?? '';
  }
  if (!opfPath) throw new Error('EPUB non valido: nessun file OPF trovato');

  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB non valido: OPF non trovato (${opfPath})`);

  const opf = xmlParser.parse(opfEntry.getData().toString('utf8')) as Record<string, any>;
  const pkg = opf?.package ?? opf;
  const metadata = pkg?.metadata ?? {};
  const manifestItems = asArray(pkg?.manifest?.item);
  const spineItems = asArray(pkg?.spine?.itemref);

  const manifest = new Map<string, any>();
  for (const item of manifestItems) {
    if (item?.['@id']) manifest.set(item['@id'], item);
  }

  /* ---------------- metadati ---------------- */
  const titles = asArray(metadata?.title).map(textOf).filter(Boolean);
  const title = titles[0] ?? '';
  const subtitle =
    titles.length > 1
      ? titles[1]
      : firstNonEmpty(
          ...asArray(metadata?.['meta'])
            .filter((m: any) => String(m?.['@property'] ?? '').includes('title-type'))
            .filter((m: any) => String(m?.['@refines'] ?? '').length > 0)
            .map((m: any) => textOf(m)),
        );

  const creators = asArray(metadata?.creator).map((c: any) => ({
    name: textOf(c),
    role: String(c?.['@role'] ?? c?.['@scheme'] ?? ''),
  }));
  const authors = creators
    .filter((c) => !c.role || /aut|author|writer|creator/i.test(c.role))
    .map((c) => c.name)
    .filter(Boolean);
  const otherCreators = creators
    .filter((c) => c.role && !/aut|author|writer|creator/i.test(c.role))
    .map((c) => c.name)
    .filter(Boolean);

  const identifiersRaw = asArray(metadata?.identifier);
  const identifiers: Record<string, string> = {};
  let isbn = '';
  for (const id of identifiersRaw) {
    const value = textOf(id);
    if (!value) continue;
    const scheme = String(id?.['@scheme'] ?? '').toLowerCase();
    const idProp = String(id?.['@property'] ?? '').toLowerCase();
    if (scheme.includes('isbn') || /isbn[:\s]/i.test(value)) {
      isbn = isbn || value.replace(/^(?:urn:)?isbn[:\s]*/i, '').trim();
      identifiers.isbn = isbn;
    } else if (idProp.includes('identifier')) {
      identifiers[idProp] = value;
    } else if (scheme) {
      identifiers[scheme] = value;
    } else {
      identifiers.uuid = identifiers.uuid ?? value;
    }
  }

  const metaTags = asArray(metadata?.meta);
  const metaByName = new Map<string, string>();
  for (const meta of metaTags) {
    const name = String(meta?.['@name'] ?? '').toLowerCase();
    if (name) metaByName.set(name, textOf(meta?.['@content'] ?? meta));
    // EPUB3: <meta property="belongs-to-collection">Serie</meta> e group-position.
    const property = String(meta?.['@property'] ?? '').toLowerCase();
    if ((property === 'belongs-to-collection' || property === 'group-position') && !metaByName.has(property)) {
      metaByName.set(property, textOf(meta));
    }
  }

  const series =
    metaByName.get('calibre:series') ??
    metaByName.get('series') ??
    metaByName.get('belongs-to-collection') ??
    metaByName.get('belongs-to-collection') ??
    '';
  const seriesIndexRaw =
    metaByName.get('calibre:series_index') ??
    metaByName.get('series_index') ??
    metaByName.get('group-position') ??
    '';
  const seriesIndex = seriesIndexRaw ? Number.parseFloat(seriesIndexRaw) : null;

  const description = firstNonEmpty(
    ...asArray(metadata?.description).map(textOf),
    metaByName.get('description') ?? '',
  );

  const publishedDate = firstNonEmpty(
    ...asArray(metadata?.date)
      .filter((d: any) => {
        const props = String(d?.['@property'] ?? '');
        return !props || props.includes('date');
      })
      .map(textOf),
  );

  const subjects = asArray(metadata?.subject).map(textOf).filter(Boolean);

  /* ---------------- copertina ---------------- */
  let coverEntryName = '';
  const coverImageItem = manifestItems.find((item: any) =>
    String(item?.['@properties'] ?? '')
      .split(/\s+/)
      .includes('cover-image'),
  );
  if (coverImageItem) coverEntryName = coverImageItem['@href'] ?? '';

  if (!coverEntryName) {
    const coverMetaId = metaByName.get('cover');
    if (coverMetaId && manifest.has(coverMetaId)) {
      coverEntryName = manifest.get(coverMetaId)['@href'] ?? '';
    }
  }
  if (!coverEntryName) {
    const guess = manifestItems.find(
      (item: any) =>
        String(item?.['@media-type'] ?? '').startsWith('image/') &&
        /cover/i.test(String(item?.['@href'] ?? '')),
    );
    if (guess) coverEntryName = guess['@href'] ?? '';
  }
  if (!coverEntryName) {
    const firstImage = manifestItems.find((item: any) =>
      String(item?.['@media-type'] ?? '').startsWith('image/'),
    );
    if (firstImage) coverEntryName = firstImage['@href'] ?? '';
  }

  let cover: ExtractedCover | null = null;
  if (coverEntryName) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), coverEntryName));
    const entry = zip.getEntry(resolved) ?? zip.getEntry(coverEntryName);
    if (entry) {
      cover = {
        data: entry.getData(),
        ext: path.extname(entry.entryName).toLowerCase() || '.jpg',
      };
    }
  }

  /* ---------------- testo ---------------- */
  const opfDir = path.posix.dirname(opfPath);
  const textParts: string[] = [];
  const infoParts: string[] = [];
  let headText = '';
  let wordCount = 0;

  const spineHrefs: string[] = [];
  for (const ref of spineItems) {
    const item = manifest.get(ref?.['@idref']);
    if (item?.['@href']) spineHrefs.push(item['@href']);
  }
  if (spineHrefs.length === 0) {
    for (const item of manifestItems) {
      const mediaType = String(item?.['@media-type'] ?? '');
      if (/xhtml|html/.test(mediaType)) spineHrefs.push(item['@href']);
    }
  }

  for (const href of spineHrefs) {
    const resolved = path.posix.normalize(path.posix.join(opfDir, href));
    const entry = zip.getEntry(resolved) ?? zip.getEntry(href);
    if (!entry) continue;
    const text = htmlToText(entry.getData().toString('utf8'));
    if (!text) continue;
    wordCount += countWords(text);
    textParts.push(text);
    if (looksLikeInfoPage(href)) infoParts.push(text);
  }

  const fullText = textParts.join('\n');
  headText = fullText.slice(0, 12000);

  const infoText = infoParts.length
    ? infoParts.join('\n').slice(0, 12000)
    : (() => {
        // L'informativa e' spesso nella prima pagina: cerchiamo un blocco
        // compatto di coppie "Etichetta: valore".
        const match = fullText.match(/(?:^|\n)(?:[A-Z][A-Za-z ()\/'.-]{2,30}:[^\n]*\n?){4,}/);
        return match ? match[0].slice(0, 8000) : '';
      })();

  return {
    title,
    subtitle,
    authors: authors.length ? authors : otherCreators,
    language: firstNonEmpty(...asArray(metadata?.language).map(textOf)),
    publisher: firstNonEmpty(...asArray(metadata?.publisher).map(textOf)),
    publishedDate,
    isbn,
    identifiers,
    description,
    subjects,
    series,
    seriesIndex: seriesIndex !== null && Number.isFinite(seriesIndex) ? seriesIndex : null,
    cover,
    wordCount,
    charCount: fullText.length,
    chapters: spineHrefs.length,
    headText,
    infoText,
  };
}
