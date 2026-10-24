import AdmZip from 'adm-zip';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SKRSContext2D } from '@napi-rs/canvas';
import {
  emptyMeta,
  findDuplicateInIndex,
  sanitizeFolderName,
  uniqueFolderName,
  updateBook,
  writeBookJsonPublic,
} from './library.js';
import { loadIndex, loadSettings, saveIndex } from './store.js';
import { notifyBook } from './bookEvents.js';
import { currentLibrary } from './libraries.js';
import { normalizeTags } from './tags.js';
import type { BookMeta } from '../../shared/types.js';
import type { DuplicateMatch } from './library.js';
import {
  EPUB_TEXT_CSS,
  OdtTextStyles,
  blocksToOdt,
  blocksToXhtml,
  decodeHtmlEntities,
  escapeXml,
  htmlToBlocks,
  paragraphText,
  type EfpParagraph,
} from './efpHtml.js';

const BASE = 'https://www.efpfanfic.net';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAX_BYTES = 30 * 1024 * 1024;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 20;

export interface EfpChapter {
  number: number;
  title: string;
  /** Paragrafi con la formattazione del testo originale (corsivi, centrati...). */
  paragraphs: EfpParagraph[];
}

export interface EfpStory {
  sid: string;
  url: string;
  title: string;
  author: string;
  category: string;
  fandom: string;
  summary: string;
  genres: string[];
  status: string;
  rating: string;
  /** Tipo di coppia: Het, Slash, Shonen-ai, ... */
  pairingTypes: string[];
  /** Coppie: "Hinata/Naruto", ... */
  relationships: string[];
  warnings: string[];
  context: string;
  characters: string[];
  publishedDate: string;
  series: string;
  seriesId: string;
  seriesIndex: number | null;
  /** Campo "Note" di EFP: sono etichette (AU, What if?, Raccolta), non testo libero. */
  notes: string[];
  /** Sottocategoria delle storie originali (Poesia, Fantasy, ...). */
  subcategory: string;
  chapters: EfpChapter[];
  wordCount: number;
}

interface StoryPageMeta {
  title: string;
  author: string;
  authorId: string;
  category: string;
  categoryId: string;
  summary: string;
  genres: string[];
  status: string;
  rating: string;
  pairingTypes: string[];
  relationships: string[];
  warnings: string[];
  context: string;
  characters: string[];
  publishedDate: string;
  series: string;
  seriesId: string;
  notes: string[];
}

interface CacheEntry {
  at: number;
  story: EfpStory;
}

const storyCache = new Map<string, CacheEntry>();

/* --------------------------------------------------------------- utilita' -- */

function decodeEntities(value: string): string {
  return decodeHtmlEntities(value).replace(/\u00a0/g, ' ');
}

/** Toglie solo i veri tag: "<< battuta >>" scritto senza entita' resta testo. */
const TAG_PATTERN = /<\/?[a-zA-Z!][^<>]*>/g;

function cleanText(value: string): string {
  return decodeEntities(value.replace(TAG_PATTERN, ' '))
    .replace(/[\u00a0\s]+/g, ' ')
    .trim();
}

function matchText(source: string, pattern: RegExp): string {
  const match = source.match(pattern);
  return match ? cleanText(match[1] ?? '') : '';
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitList(value: string): string[] {
  return unique(
    value
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter((part) => part && !/^(nessun[oa]?|none)$/i.test(part)),
  );
}

/** "31/08/2026" o "31/08/26" (pagine autore) -> "2026-08-31". */
function isoDate(value: string): string {
  const match = value.match(/(\d{2})\/(\d{2})\/(\d{4}|\d{2})\b/);
  if (!match) return '';
  const year = match[3]!.length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2]}-${match[1]}`;
}

function safeFileName(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'storia-efp'
  );
}

/* ------------------------------------------------------------ download -- */

export function parseEfpUrl(input: string): { sid: string; url: string } {
  const value = input.trim();
  if (!value) throw new Error('Incolla il link di una storia EFP.');
  if (/^\d+$/.test(value)) {
    return { sid: value, url: `${BASE}/viewstory.php?sid=${value}` };
  }

  let candidate = value;
  if (/^(viewstory|printsave)\.php/i.test(candidate)) candidate = `${BASE}/${candidate}`;
  else if (!/^https?:/i.test(candidate)) candidate = `https://${candidate}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Link EFP non valido.');
  }
  if (!/(^|\.)efpfanfic\.net$/i.test(parsed.hostname)) {
    throw new Error('Il link deve essere di efpfanfic.net.');
  }
  const sid = parsed.searchParams.get('sid') ?? parsed.pathname.match(/(\d+)/)?.[1] ?? '';
  if (!/^\d+$/.test(sid)) {
    throw new Error('Link EFP non valido: manca il parametro sid.');
  }
  return { sid, url: `${BASE}/viewstory.php?sid=${sid}` };
}

async function fetchHtml(url: string, timeoutMs = 45_000): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.6',
        Referer: `${BASE}/`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = (error as Error).name === 'TimeoutError'
      ? 'EFP non ha risposto in tempo.'
      : `EFP non raggiungibile: ${(error as Error).message}`;
    throw new Error(message);
  }
  if (!response.ok) throw new Error(`EFP ha risposto HTTP ${response.status}.`);
  if (!/(^|\.)efpfanfic\.net$/i.test(new URL(response.url).hostname)) {
    throw new Error('EFP ha reindirizzato a un dominio non consentito.');
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('La storia è troppo grande da scaricare.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('La storia è troppo grande da scaricare.');
  return new TextDecoder('windows-1252').decode(buffer);
}

/**
 * Legge i campi "Etichetta: valore" del riquadro informazioni di EFP. Piu'
 * campi stanno sulla stessa riga separati da `|` o `<br>` (es. "Tipo di coppia:
 * Het | Personaggi: ... | Coppie: ..."), quindi ogni valore si ferma al primo
 * separatore o alla prossima etichetta. Le chiavi sono in minuscolo.
 */
function parseLabeledFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(
    /<font[^>]*small-caps[^>]*>\s*([^<:]+?)\s*:\s*<\/font>/gi,
  )) {
    const label = (match[1] ?? '').trim().toLowerCase();
    if (!label || fields.has(label)) continue;
    const rest = html.slice((match.index ?? 0) + match[0].length);
    const raw = rest.match(/^([\s\S]*?)(?=<font|<br|<img|<\/div>|<select|\|)/i)?.[1] ?? '';
    fields.set(label, cleanText(raw));
  }
  return fields;
}

/** Sinossi: mantiene gli a capo (`<br>`) come righe, senza spezzarla in paragrafi. */
function summaryText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div)>/gi, '\n')
      .replace(TAG_PATTERN, ''),
  )
    .split('\n')
    .map((line) => line.replace(/[ \s]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function parseStoryPage(html: string): StoryPageMeta {
  const fields = parseLabeledFields(html);
  const field = (label: string): string => fields.get(label) ?? '';

  const title =
    matchText(
      html,
      /<div style="font-weight: bold; font-variant: small-caps; font-size: 1\.3em;">\s*<a[^>]*>([\s\S]*?)<\/a>/i,
    ) ||
    // og:title = "Categoria, 'Titolo' di Autore": il titolo puo' contenere apostrofi.
    decodeEntities(html.match(/<meta property="og:title" content="[^"]*?'(.+)' di [^"]*"/i)?.[1] ?? '');

  const author =
    matchText(
      html,
      /Autore:<\/font>\s*<a href="viewuser\.php\?uid=\d+">([\s\S]*?)<\/a>/i,
    ) || field('autore');

  const authorId = html.match(/Autore:<\/font>\s*<a href="viewuser\.php\?uid=(\d+)"/i)?.[1] ?? '';

  // Il percorso di categorie e' un <div> fatto solo di link "categories.php"
  // (nella pagina normale e in quella riservata ai maggiorenni cambia lo stile).
  const categoryHtml =
    html.match(
      /<div[^>]*>\s*((?:<a href="categories\.php\?catid=\d+[^"]*">[^<]*<\/a>\s*>?\s*)+)<\/div>/i,
    )?.[1] ?? '';
  const categoryLinks = [
    ...categoryHtml.matchAll(/<a href="categories\.php\?catid=(\d+)[^"]*">([^<]*)<\/a>/gi),
  ];
  const category = unique(categoryLinks.map((item) => cleanText(item[2] ?? ''))).join(' > ');
  const categoryId = categoryLinks.at(-1)?.[1] ?? '';

  const summaryHtml = html.match(/<div id="anteprima">([\s\S]*?)<\/div>/i)?.[1] ?? '';
  const summary = summaryText(summaryHtml);

  const publishedDate = isoDate(
    html.match(/calendar\.png[^>]*>\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? '',
  );

  // "Questa storia fa parte della serie '<a href="viewseries.php?ssid=N">Nome</a>'"
  const seriesMatch = html.match(
    /fa parte della serie\s*'?\s*<a href="viewseries\.php\?ssid=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
  );
  const series = seriesMatch ? cleanText(seriesMatch[2] ?? '') : field('serie');
  const seriesId = seriesMatch?.[1] ?? '';

  const ratingId =
    html.match(/<div id="(giallo|rosso|verde|arancione|arancio|blu)"/i)?.[1]?.toLowerCase() ??
    '';
  const context = field('contesto');

  return {
    title,
    author,
    authorId,
    category,
    categoryId,
    summary,
    genres: splitList(field('genere')),
    status: field('stato'),
    rating: ratingId,
    pairingTypes: splitList(field('tipo di coppia')),
    relationships: splitList(field('coppie')),
    warnings: splitList(field('avvertimenti')),
    context: /^(nessun[oa]?|none)$/i.test(context) ? '' : context,
    characters: splitList(field('personaggi')),
    publishedDate,
    series,
    seriesId,
    notes: splitList(field('note')),
  };
}

/**
 * Posizione della storia nella serie. La pagina della serie non riporta un
 * numero d'ordine, quindi si usa l'ordine di pubblicazione (sid crescente).
 * Best effort: se la pagina non e' leggibile restituisce null.
 */
async function loadSeriesIndex(seriesId: string, sid: string): Promise<number | null> {
  try {
    const html = await fetchHtml(`${BASE}/viewseries.php?ssid=${seriesId}&i=1`, 20_000);
    const sids = unique(
      [...html.matchAll(/class="titlestoria"[^>]*>\s*<a href="viewstory\.php\?sid=(\d+)/gi)].map(
        (match) => match[1] ?? '',
      ),
    ).sort((left, right) => Number(left) - Number(right));
    const position = sids.indexOf(sid);
    return position >= 0 ? position + 1 : null;
  } catch {
    return null;
  }
}

const AUTHOR_PAGE_SIZE = 15;
const AUTHOR_MAX_PAGES = 10;

/**
 * Scheda della storia nella pagina dell'autore. Serve per le storie a rating
 * rosso: senza login la loro pagina mostra solo titolo, sinossi e personaggi,
 * mentre l'elenco dell'autore riporta tutti i metadati, ad es.
 *   "Pubblicata: 06/01/19 | Aggiornata: 11/08/26 | Rating: Rosso<br>
 *    Genere: Angst, Azione | Capitoli: 64 | In corso<br>Tipo di coppia: ..."
 */
async function loadAuthorListing(
  authorId: string,
  categoryId: string,
  sid: string,
): Promise<Map<string, string> | null> {
  for (let page = 0; page < AUTHOR_MAX_PAGES; page += 1) {
    let html: string;
    try {
      html = await fetchHtml(
        `${BASE}/viewuser.php?uid=${authorId}&catid=${categoryId}&offset=${page * AUTHOR_PAGE_SIZE}`,
        20_000,
      );
    } catch {
      return null;
    }
    const blocks = html.split(/<div class="storybloc">/i).slice(1);
    const block = blocks.find((item) =>
      new RegExp(`class="titlestoria"[^>]*>\\s*<a href="viewstory\\.php\\?sid=${sid}[&"]`, 'i').test(
        item,
      ),
    );
    if (block) {
      const notes = block.match(/<div class="notebloc">([\s\S]*?)<\/div>/i)?.[1] ?? '';
      const fields = new Map<string, string>();
      for (const part of notes.split(/\||<br\s*\/?>/i)) {
        const text = cleanText(part);
        const labeled = text.match(/^([^:]+):\s*(.*)$/);
        if (labeled) fields.set(labeled[1]!.trim().toLowerCase(), labeled[2]!.trim());
        else if (/^(in corso|complet[ao]|sospes[ao])$/i.test(text)) fields.set('stato', text);
      }
      return fields;
    }
    if (blocks.length < AUTHOR_PAGE_SIZE) return null;
  }
  return null;
}

/** Completa i campi vuoti della pagina storia con quelli dell'elenco autore. */
function mergeAuthorListing(meta: StoryPageMeta, listing: Map<string, string>): StoryPageMeta {
  const get = (label: string): string => listing.get(label) ?? '';
  const pick = (current: string[], label: string): string[] =>
    current.length ? current : splitList(get(label));
  const context = meta.context || get('contesto');
  return {
    ...meta,
    category: meta.category || get('categoria'),
    genres: pick(meta.genres, 'genere'),
    status: meta.status || get('stato'),
    rating: meta.rating || get('rating').toLowerCase(),
    pairingTypes: pick(meta.pairingTypes, 'tipo di coppia'),
    relationships: pick(meta.relationships, 'coppie'),
    warnings: pick(meta.warnings, 'avvertimenti'),
    context: /^(nessun[oa]?|none)$/i.test(context) ? '' : context,
    characters: pick(meta.characters, 'personaggi'),
    publishedDate: meta.publishedDate || isoDate(get('pubblicata')),
    notes: pick(meta.notes, 'note'),
  };
}

/** Etichette della storia per `book.json` e per i metadati di EPUB/ODT. */
function storyTags(story: EfpStory): string[] {
  return unique([
    ...story.genres,
    story.subcategory,
    ...story.pairingTypes,
    ...story.notes,
    ...story.warnings,
    story.context,
  ]).filter((tag) => tag && !/^(nessun[oa]?|none)$/i.test(tag));
}

function parsePrintall(html: string): EfpChapter[] {
  const toc = new Map<number, string>();
  for (const item of html.matchAll(
    /<a href="#(\d+)">Capitolo\s+\d+:<\/a><\/b>\s*([\s\S]*?)<\/big>/gi,
  )) {
    const title = cleanText(item[2] ?? '')
      .replace(/\*+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    toc.set(Number(item[1]), title);
  }

  const starts = [...html.matchAll(/<center>\s*<p class="titolo">\s*<a name="(\d+)">/gi)];
  if (!starts.length) {
    throw new Error(
      'Nessun capitolo trovato. La storia potrebbe richiedere il login a EFP.',
    );
  }

  const chapters: EfpChapter[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const number = Number(start[1]);
    const begin = (start.index ?? 0) + start[0].length;
    const end = starts[index + 1]?.index ?? html.length;
    const block = html.slice(begin, end);

    const headerEndMatch = /<\/p>\s*<\/center>/i.exec(block);
    const headerEnd = headerEndMatch?.index ?? -1;
    const header = headerEnd >= 0 ? block.slice(0, headerEnd) : '';
    const body =
      headerEnd >= 0
        ? block.slice(headerEnd + (headerEndMatch?.[0].length ?? '</p></center>'.length))
        : block;

    const headerTitle = cleanText(
      header.replace(/^[\s\S]*?<\/a>/i, '').replace(/^\s*[-–—:]\s*/, ''),
    )
      .replace(/\*+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const title = toc.get(number) || headerTitle || `Capitolo ${number}`;
    // Dopo il testo EFP aggiunge "Ritorna all'indice" e, in fondo, il link alla storia.
    const textEnd = body.search(/<p[^>]*>\s*(?:<big>\s*)?<a href="#top">/i);
    const paragraphs = htmlToBlocks(textEnd >= 0 ? body.slice(0, textEnd) : body);
    // Molte autrici ripetono il titolo in testa al capitolo: si toglie, insieme
    // alle righe vuote che lo seguivano.
    const comparable = (value: string): string =>
      value.replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/\*+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (title && paragraphs[0] && comparable(paragraphText(paragraphs[0])) === comparable(title)) {
      paragraphs.shift();
      while (paragraphs[0] && !paragraphs[0].runs.length && !paragraphs[0].separator) paragraphs.shift();
    }
    if (paragraphs.length) chapters.push({ number, title, paragraphs });
  }

  return chapters.sort((left, right) => left.number - right.number);
}

function wordCountOf(chapters: EfpChapter[]): number {
  return chapters.reduce(
    (total, chapter) =>
      total +
      chapter.paragraphs.reduce(
        (sum, paragraph) => sum + paragraphText(paragraph).split(/\s+/).filter(Boolean).length,
        0,
      ),
    0,
  );
}

/** Con `fresh` salta la cache (10 minuti): serve al controllo degli aggiornamenti. */
export async function loadEfpStory(
  input: string,
  options: { fresh?: boolean } = {},
): Promise<EfpStory> {
  const { sid: requestedSid, url: requestedUrl } = parseEfpUrl(input);
  const cachedRequested = options.fresh ? undefined : storyCache.get(requestedSid);
  if (cachedRequested && Date.now() - cachedRequested.at < CACHE_TTL) {
    return cachedRequested.story;
  }

  const pageHtml = await fetchHtml(requestedUrl);
  if (
    /Per leggere questa storia/i.test(pageHtml) &&
    !/printsave\.php\?action=printall/i.test(pageHtml)
  ) {
    throw new Error(
      'Questa storia richiede un account EFP e l’accesso con maggiore età. ' +
        'Apri EFP nel browser, accedi e riprova con una storia accessibile senza login.',
    );
  }

  const chapterSelect =
    pageHtml.match(/<select name="sid"[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? '';
  const firstChapterSid =
    chapterSelect.match(/<option value="viewstory\.php\?sid=(\d+)/i)?.[1] ?? '';
  const sid = firstChapterSid || requestedSid;
  const url = `${BASE}/viewstory.php?sid=${sid}`;

  const cached = options.fresh ? undefined : storyCache.get(sid);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    storyCache.set(requestedSid, cached);
    return cached.story;
  }

  let meta = parseStoryPage(pageHtml);
  if (!meta.title) throw new Error('Titolo della storia non riconosciuto.');
  if (!meta.genres.length && !meta.status && meta.authorId) {
    const listing = await loadAuthorListing(meta.authorId, meta.categoryId, sid);
    if (listing) meta = mergeAuthorListing(meta, listing);
  }
  const { authorId: _authorId, categoryId: _categoryId, ...pageMeta } = meta;

  const printallUrl = `${BASE}/printsave.php?action=printall&sid=${sid}`;
  const printallHtml = await fetchHtml(printallUrl, 60_000);
  const chapters = parsePrintall(printallHtml);
  if (!chapters.length) throw new Error('La storia non contiene capitoli scaricabili.');

  // "Anime & Manga > Naruto" -> fandom "Naruto";
  // "Storie originali > Poesia" -> fandom "Storie originali", sottocategoria "Poesia".
  const segments = meta.category.split(' > ').filter(Boolean);
  const original = /^storie originali/i.test(meta.category);
  const fandom = original ? 'Storie originali' : segments.at(-1) || meta.category;
  const subcategory = original ? segments.slice(1).join(' > ') : '';
  const seriesIndex = meta.seriesId ? await loadSeriesIndex(meta.seriesId, sid) : null;

  const story: EfpStory = {
    sid,
    url,
    ...pageMeta,
    fandom,
    subcategory,
    seriesIndex,
    chapters,
    wordCount: wordCountOf(chapters),
  };

  storyCache.set(sid, { at: Date.now(), story });
  storyCache.set(requestedSid, { at: Date.now(), story });
  if (storyCache.size > CACHE_MAX) {
    const oldest = [...storyCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) storyCache.delete(oldest[0]);
  }
  return story;
}

/* ------------------------------------------------------------ copertina -- */

const COVER_W = 1200;
const COVER_H = 1800;
const COVER_INK = '#181510';
const COVER_ACCENT = '#477e67';
const COVER_ACCENT_DARK = '#235347';
const COVER_PAPER = '#f8f5ee';

function wrapCoverLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Genera una copertina PNG (2:3) con titolo, autore, fandom e generi.
 * Restituisce `null` se il rendering non e' disponibile, cosi' l'import non
 * fallisce mai per colpa della copertina.
 */
export async function renderCover(story: EfpStory): Promise<Buffer | null> {
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(COVER_W, COVER_H);
    const ctx = canvas.getContext('2d') as SKRSContext2D;

    ctx.fillStyle = COVER_PAPER;
    ctx.fillRect(0, 0, COVER_W, COVER_H);

    ctx.fillStyle = COVER_ACCENT;
    ctx.fillRect(0, 0, COVER_W, 340);
    ctx.fillRect(0, COVER_H - 300, COVER_W, 300);
    ctx.fillStyle = COVER_ACCENT_DARK;
    ctx.fillRect(0, 340, COVER_W, 10);
    ctx.fillRect(0, COVER_H - 310, COVER_W, 10);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const serif = 'Georgia, "Times New Roman", "DejaVu Serif", serif';
    const sans = '"Avenir Next", "Helvetica Neue", "DejaVu Sans", sans-serif';

    ctx.fillStyle = COVER_PAPER;
    ctx.font = `600 34px ${sans}`;
    const fandom = (story.fandom || 'Fanfiction').toUpperCase();
    ctx.fillText(fandom.slice(0, 60), COVER_W / 2, 150);

    const titleWidth = COVER_W - 200;
    let titleSize = 44;
    let titleLines: string[] = [];
    for (let size = 112; size >= 44; size -= 6) {
      ctx.font = `bold ${size}px ${serif}`;
      titleLines = wrapCoverLines(ctx, story.title, titleWidth);
      if (titleLines.length * size * 1.15 <= 780) {
        titleSize = size;
        break;
      }
      titleSize = size;
    }
    const lineHeight = titleSize * 1.18;
    const titleBlock = titleLines.length * lineHeight;
    const titleTop = 940 - titleBlock / 2;
    ctx.fillStyle = COVER_INK;
    ctx.font = `bold ${titleSize}px ${serif}`;
    titleLines.forEach((line, index) => {
      ctx.fillText(line, COVER_W / 2, titleTop + index * lineHeight);
    });

    ctx.fillStyle = COVER_ACCENT_DARK;
    ctx.font = `italic 52px ${serif}`;
    ctx.fillText(story.author || 'Anonimo', COVER_W / 2, titleTop + titleBlock + 80);

    ctx.fillStyle = COVER_PAPER;
    ctx.font = `40px ${serif}`;
    const genres = story.genres.join('  ·  ');
    if (genres) ctx.fillText(genres.slice(0, 80), COVER_W / 2, COVER_H - 160);

    return canvas.toBuffer('image/png');
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- EPUB -- */

const EPUB_CSS = `body { font-family: Georgia, serif; line-height: 1.6; margin: 0 1.2em; }
h1 { font-size: 1.4em; text-align: center; margin: 2em 0 1em; }
p { margin: 0 0 0.8em; text-align: justify; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { font-size: 2em; }
.title-page .author { font-size: 1.2em; font-style: italic; }
.title-page .source { margin-top: 2em; font-size: 0.8em; color: #666; }
.cover { text-align: center; margin: 0; }
.cover img { display: block; margin: 0 auto; width: 100%; max-width: 600px; height: auto; }
${EPUB_TEXT_CSS}`;

function chapterXhtml(story: EfpStory, chapter: EfpChapter): string {
  const paragraphs = blocksToXhtml(chapter.paragraphs);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="it" lang="it">
  <head>
    <title>${escapeXml(chapter.title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <section>
      <h1>${escapeXml(chapter.title)}</h1>
${paragraphs}
    </section>
  </body>
</html>`;
}

function coverXhtml(story: EfpStory): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="it" lang="it">
  <head>
    <title>${escapeXml(story.title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <section class="cover">
      <img src="cover.png" alt="${escapeXml(story.title)}"/>
    </section>
  </body>
</html>`;
}

function epubSubjects(story: EfpStory): string {
  return unique([...storyTags(story), ...story.characters, ...story.relationships])
    .map((tag) => `    <dc:subject>${escapeXml(tag)}</dc:subject>`)
    .join('\n');
}

export async function buildEpub(story: EfpStory, cover?: Buffer | null): Promise<Buffer> {
  const coverBuffer = cover === undefined ? await renderCover(story) : cover;
  const zip = new AdmZip(undefined, { noSort: true });
  const mimetype = zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  mimetype.header.method = 0;

  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const subjects = epubSubjects(story);
  const customMeta = [
    story.rating
      ? `    <meta name="efp:rating" content="${escapeXml(ratingLabel(story.rating))}"/>`
      : '',
    story.status
      ? `    <meta name="efp:status" content="${escapeXml(capitalize(story.status))}"/>`
      : '',
    story.series
      ? `    <meta property="belongs-to-collection" id="series">${escapeXml(story.series)}</meta>\n` +
        '    <meta refines="#series" property="collection-type">series</meta>' +
        (story.seriesIndex
          ? `\n    <meta refines="#series" property="group-position">${story.seriesIndex}</meta>`
          : '')
      : '',
    story.chapters.length
      ? `    <meta name="efp:chapters" content="${story.chapters.length}"/>`
      : '',
    story.wordCount ? `    <meta name="efp:wordCount" content="${story.wordCount}"/>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const published = story.publishedDate
    ? `    <dc:date>${escapeXml(story.publishedDate)}</dc:date>\n`
    : '';
  const coverMeta = coverBuffer ? '    <meta name="cover" content="cover-image"/>\n' : '';
  const coverManifest = coverBuffer
    ? '    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>\n' +
      '    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n'
    : '';
  const coverSpine = coverBuffer ? '    <itemref idref="cover"/>\n' : '';
  const manifest = story.chapters
    .map(
      (chapter) =>
        `    <item id="cap-${chapter.number}" href="cap-${chapter.number}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join('\n');
  const spine = story.chapters
    .map((chapter) => `    <itemref idref="cap-${chapter.number}"/>`)
    .join('\n');
  const navItems = story.chapters
    .map(
      (chapter) =>
        `        <li><a href="cap-${chapter.number}.xhtml">${escapeXml(chapter.title)}</a></li>`,
    )
    .join('\n');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="it">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">efp-${story.sid}</dc:identifier>
    <dc:title>${escapeXml(story.title)}</dc:title>
    <dc:creator>${escapeXml(story.author || 'Anonimo')}</dc:creator>
    <dc:language>it</dc:language>
    <dc:source>${escapeXml(story.url)}</dc:source>
${published}    <dc:description>${escapeXml(story.summary)}</dc:description>
${subjects}
${customMeta}
    <meta property="dcterms:modified">${modified}</meta>
${coverMeta}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${coverManifest}${manifest}
  </manifest>
  <spine>
${coverSpine}${spine}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="it" lang="it">
  <head><title>${escapeXml(story.title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${escapeXml(story.title)}</h1>
      <ol>
${navItems}
      </ol>
    </nav>
  </body>
</html>`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  zip.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  zip.addFile('OEBPS/style.css', Buffer.from(EPUB_CSS, 'utf8'));
  if (coverBuffer) {
    zip.addFile('OEBPS/cover.png', coverBuffer);
    zip.addFile('OEBPS/cover.xhtml', Buffer.from(coverXhtml(story), 'utf8'));
  }
  for (const chapter of story.chapters) {
    zip.addFile(
      `OEBPS/cap-${chapter.number}.xhtml`,
      Buffer.from(chapterXhtml(story, chapter), 'utf8'),
    );
  }
  return zip.toBuffer();
}

/* ---------------------------------------------------------------- ODT -- */

export async function buildOdt(story: EfpStory, cover?: Buffer | null): Promise<Buffer> {
  const coverBuffer = cover === undefined ? await renderCover(story) : cover;
  const zip = new AdmZip(undefined, { noSort: true });
  const mimetype = zip.addFile('mimetype', Buffer.from('application/vnd.oasis.opendocument.text'));
  mimetype.header.method = 0;

  const infoRows: Array<[string, string]> = [];
  if (story.fandom) {
    infoRows.push([
      'Fandom',
      story.subcategory ? `${story.fandom} > ${story.subcategory}` : story.fandom,
    ]);
  }
  if (story.genres.length) infoRows.push(['Generi', story.genres.join(', ')]);
  if (story.rating) infoRows.push(['Rating', ratingLabel(story.rating)]);
  if (story.status) infoRows.push(['Stato', capitalize(story.status)]);
  if (story.pairingTypes.length) infoRows.push(['Tipo di coppia', story.pairingTypes.join(', ')]);
  if (story.characters.length) infoRows.push(['Personaggi', story.characters.join(', ')]);
  if (story.relationships.length) infoRows.push(['Coppie', story.relationships.join(', ')]);
  if (story.notes.length) infoRows.push(['Note', story.notes.join(', ')]);
  if (story.warnings.length) infoRows.push(['Avvertimenti', story.warnings.join(', ')]);
  if (story.context) infoRows.push(['Contesto', story.context]);
  if (story.series) {
    infoRows.push([
      'Serie',
      story.seriesIndex ? `${story.series} (n. ${story.seriesIndex})` : story.series,
    ]);
  }
  if (story.publishedDate) infoRows.push(['Pubblicata', story.publishedDate]);
  infoRows.push(['Capitoli', String(story.chapters.length)]);
  if (story.wordCount) infoRows.push(['Parole', String(story.wordCount)]);

  const infoRowsXml = infoRows
    .map(
      ([label, value]) =>
        `      <text:p text:style-name="Text_20_body"><text:span text:style-name="InfoLabel">${escapeXml(
          label,
        )}:</text:span> ${escapeXml(value)}</text:p>`,
    )
    .join('\n');

  const infoSection = infoRows.length
    ? `<text:h text:style-name="Heading_20_2" text:outline-level="2">Informazioni</text:h>
${infoRowsXml}`
    : '';

  const coverXml = coverBuffer
    ? `<draw:frame draw:style-name="frCover" draw:name="Copertina" text:anchor-type="paragraph" svg:width="8cm" svg:height="12cm">
        <draw:image xlink:href="Pictures/cover.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>
      </draw:frame>
      `
    : '';

  const summary = story.summary
    ? `<text:h text:style-name="Heading_20_2" text:outline-level="2">Sinossi</text:h>
${story.summary
  .split(/\n+/)
  .map((paragraph) => `<text:p text:style-name="Text_20_body">${escapeXml(paragraph)}</text:p>`)
  .join('\n')}`
    : '';

  const textStyles = new OdtTextStyles();
  const chapters = story.chapters
    .map((chapter) => {
      const paragraphs = blocksToOdt(chapter.paragraphs, textStyles);
      return `<text:h text:style-name="Heading_20_1" text:outline-level="1">${escapeXml(chapter.title)}</text:h>
${paragraphs}`;
    })
    .join('\n');

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:svg="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  office:version="1.2">
  <office:automatic-styles>
    <style:style style:name="Title" style:family="paragraph">
      <style:paragraph-properties fo:text-align="center" fo:margin-top="1cm" fo:margin-bottom="0.5cm"/>
      <style:text-properties fo:font-size="22pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="Subtitle" style:family="paragraph">
      <style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.3cm"/>
      <style:text-properties fo:font-size="13pt" fo:font-style="italic"/>
    </style:style>
    <style:style style:name="Source" style:family="paragraph">
      <style:paragraph-properties fo:text-align="center" fo:margin-bottom="1cm"/>
      <style:text-properties fo:font-size="9pt" fo:color="#666666"/>
    </style:style>
    <style:style style:name="frCover" style:family="graphic">
      <style:graphic-properties style:vertical-pos="top" style:vertical-rel="paragraph" style:horizontal-pos="center" style:horizontal-rel="paragraph" style:border="none"/>
    </style:style>
    <style:style style:name="InfoLabel" style:family="text">
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="Text_20_body" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:margin-bottom="0.25cm" fo:text-align="justify"/>
    </style:style>
    <style:style style:name="Heading_20_1" style:family="paragraph" style:parent-style-name="Heading">
      <style:paragraph-properties fo:margin-top="0.8cm" fo:margin-bottom="0.4cm" fo:break-before="page"/>
      <style:text-properties fo:font-size="16pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="Heading_20_2" style:family="paragraph" style:parent-style-name="Heading">
      <style:paragraph-properties fo:margin-top="0.8cm" fo:margin-bottom="0.3cm"/>
      <style:text-properties fo:font-size="13pt" fo:font-weight="bold"/>
    </style:style>
${textStyles.xml()}
  </office:automatic-styles>
  <office:body>
    <office:text>
      ${coverXml}<text:p text:style-name="Title">${escapeXml(story.title)}</text:p>
      <text:p text:style-name="Subtitle">di ${escapeXml(story.author || 'Anonimo')}</text:p>
      <text:p text:style-name="Source">${escapeXml(story.url)}</text:p>
${infoSection}
${summary}
${chapters}
    </office:text>
  </office:body>
</office:document-content>`;

  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  office:version="1.2">
  <office:styles>
    <style:default-style style:family="paragraph">
      <style:paragraph-properties fo:orphans="2" fo:widows="2"/>
      <style:text-properties fo:font-size="11pt" style:font-name="Liberation Serif"/>
    </style:default-style>
    <style:style style:name="Standard" style:family="paragraph" style:class="text"/>
    <style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:class="text">
      <style:text-properties fo:font-weight="bold"/>
    </style:style>
  </office:styles>
</office:document-styles>`;

  const tags = unique([...storyTags(story), ...story.characters, ...story.relationships]);
  const keywords = tags
    .map((tag) => `    <meta:keyword>${escapeXml(tag)}</meta:keyword>`)
    .join('\n');
  const subjects = tags
    .map((tag) => `    <dc:subject>${escapeXml(tag)}</dc:subject>`)
    .join('\n');
  const published = story.publishedDate
    ? `    <dc:date>${escapeXml(story.publishedDate)}</dc:date>\n`
    : '';
  const customMeta = [
    story.rating
      ? `    <meta:user-defined meta:name="Rating">${escapeXml(ratingLabel(story.rating))}</meta:user-defined>`
      : '',
    story.status
      ? `    <meta:user-defined meta:name="Stato">${escapeXml(story.status)}</meta:user-defined>`
      : '',
    story.series
      ? `    <meta:user-defined meta:name="Serie">${escapeXml(story.series)}</meta:user-defined>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  office:version="1.2">
  <office:meta>
    <meta:generator>books-editor EFP</meta:generator>
    <dc:title>${escapeXml(story.title)}</dc:title>
    <dc:creator>${escapeXml(story.author || 'Anonimo')}</dc:creator>
    <dc:description>${escapeXml(story.summary)}</dc:description>
    <dc:source>${escapeXml(story.url)}</dc:source>
${published}${subjects}
${keywords}
${customMeta}
  </office:meta>
</office:document-meta>`;

  const coverEntry = coverBuffer
    ? '  <manifest:file-entry manifest:full-path="Pictures/cover.png" manifest:media-type="image/png"/>\n'
    : '';

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest
  xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"
  manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${coverEntry}</manifest:manifest>`;

  zip.addFile('META-INF/manifest.xml', Buffer.from(manifest, 'utf8'));
  zip.addFile('content.xml', Buffer.from(content, 'utf8'));
  zip.addFile('styles.xml', Buffer.from(styles, 'utf8'));
  zip.addFile('meta.xml', Buffer.from(meta, 'utf8'));
  if (coverBuffer) zip.addFile('Pictures/cover.png', coverBuffer);
  return zip.toBuffer();
}

/* -------------------------------------------------------------- import -- */

export interface EfpImportResult {
  book: BookMeta;
  story: EfpStory;
  created: boolean;
}

function ratingLabel(value: string): string {
  switch (value.toLowerCase()) {
    case 'verde':
      return 'Verde';
    case 'giallo':
      return 'Giallo';
    case 'arancio':
    case 'arancione':
      return 'Arancione';
    case 'rosso':
      return 'Rosso';
    case 'blu':
      return 'Blu';
    default:
      return value;
  }
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

/** Scheda gia' presente per la stessa storia EFP (stesso sid o stesso link). */
function findSameEfpStory(story: EfpStory, index: BookMeta[]): BookMeta | undefined {
  return index.find((book) => book.identifiers?.efp === story.sid || book.efpUrl === story.url);
}

/**
 * Decide se una storia EFP si puo' importare come nuova o se esiste gia':
 * stesso sid o link (si puo' aggiornare), oppure stessa fonte / stesso titolo e autore.
 */
export function decideEfpImport(
  story: Pick<EfpStory, 'sid' | 'url' | 'title' | 'author'>,
  index: BookMeta[],
): 'new' | { duplicate: DuplicateMatch; canUpdate: boolean } {
  const same = findSameEfpStory(story as EfpStory, index);
  if (same) return { duplicate: { reason: 'source', book: same }, canUpdate: true };
  const found = findDuplicateInIndex(index, {
    title: story.title,
    authors: story.author ? [story.author] : [],
    efpUrl: story.url,
    identifiers: { efp: story.sid },
  });
  return found ? { duplicate: found, canUpdate: false } : 'new';
}

/**
 * Importa una storia EFP. Senza `mode`, se la storia e' gia' in libreria non
 * scrive nulla e restituisce il duplicato; 'update' aggiorna la scheda con lo
 * stesso sid, 'new' importa comunque come nuova scheda.
 */
export async function importEfpStory(
  input: string,
  options: { mode?: 'update' | 'new'; load?: (input: string) => Promise<EfpStory> } = {},
): Promise<EfpImportResult | { duplicate: DuplicateMatch; canUpdate: boolean }> {
  const story = await (options.load ?? loadEfpStory)(input);
  const settings = await loadSettings();
  const index = await loadIndex();

  let existing: BookMeta | undefined;
  if (options.mode === 'update') {
    existing = findSameEfpStory(story, index);
    if (!existing) throw new Error('Non c\'è una storia EFP da aggiornare.');
  } else if (options.mode !== 'new') {
    const decision = decideEfpImport(story, index);
    if (decision !== 'new') return decision;
  }

  const cover = await renderCover(story);
  const epub = await buildEpub(story, cover);
  const odt = await buildOdt(story, cover);

  const baseName = story.author ? `${story.author} - ${story.title}` : story.title;
  const fileBase = safeFileName(story.title);
  const epubName = `${fileBase}.epub`;
  const odtName = `${fileBase}.odt`;

  if (existing) {
    const folderPath = path.join(settings.libraryRoot, existing.folder);
    await fsp.mkdir(folderPath, { recursive: true });
    const previousSource = existing.sourceFile;
    const sourceFile =
      previousSource && path.extname(previousSource).toLowerCase() === '.epub'
        ? previousSource
        : epubName;
    await fsp.writeFile(path.join(folderPath, sourceFile), epub);
    await fsp.writeFile(path.join(folderPath, odtName), odt);
    if (cover) await fsp.writeFile(path.join(folderPath, 'cover.png'), cover);

    const book = await updateBook(
      existing.id,
      {
        kind: 'fanfic',
        title: story.title,
        authors: story.author ? [story.author] : existing.authors,
        fandom: story.fandom,
        description: story.summary,
        language: 'it',
        publishedDate: story.publishedDate,
        series: story.series || existing.series,
        seriesIndex: story.series ? story.seriesIndex ?? existing.seriesIndex : existing.seriesIndex,
        tags: normalizeTags(storyTags(story)),
        characters: story.characters,
        relationships: story.relationships,
        ships: story.relationships,
        fanRating: ratingLabel(story.rating),
        status: capitalize(story.status),
        chapters: story.chapters.length,
        wordCount: story.wordCount,
        efpUrl: story.url,
        identifiers: {
          ...existing.identifiers,
          efp: story.sid,
          ...(story.seriesId ? { efpSeries: story.seriesId } : {}),
        },
        format: 'epub',
        sourceFile,
        coverFile: cover ? 'cover.png' : existing.coverFile,
        extraFiles: unique([
          ...(existing.extraFiles ?? []),
          ...(previousSource && previousSource !== sourceFile ? [previousSource] : []),
          odtName,
        ]),
      },
      'online',
    );
    return { book, story, created: false };
  }

  const folder = await uniqueFolderName(settings.libraryRoot, baseName);
  const folderPath = path.join(settings.libraryRoot, folder);
  await fsp.mkdir(folderPath, { recursive: true });
  await fsp.writeFile(path.join(folderPath, epubName), epub);
  await fsp.writeFile(path.join(folderPath, odtName), odt);
  if (cover) await fsp.writeFile(path.join(folderPath, 'cover.png'), cover);

  const meta: BookMeta = {
    ...emptyMeta(),
    folder,
    sourceFile: epubName,
    format: 'epub',
    coverFile: cover ? 'cover.png' : null,
    extraFiles: [odtName],
    kind: 'fanfic',
    title: story.title,
    authors: story.author ? [story.author] : [],
    fandom: story.fandom,
    description: story.summary,
    language: 'it',
    publishedDate: story.publishedDate,
    series: story.series,
    seriesIndex: story.seriesIndex,
    tags: normalizeTags(storyTags(story)),
    characters: story.characters,
    relationships: story.relationships,
    ships: story.relationships,
    fanRating: ratingLabel(story.rating),
    status: capitalize(story.status),
    chapters: story.chapters.length,
    wordCount: story.wordCount,
    efpUrl: story.url,
    identifiers: { efp: story.sid, ...(story.seriesId ? { efpSeries: story.seriesId } : {}) },
    fieldSource: {
      title: 'online',
      authors: 'online',
      fandom: 'online',
      description: 'online',
      language: 'online',
      publishedDate: 'online',
      tags: 'online',
      characters: 'online',
      relationships: 'online',
      ships: 'online',
      fanRating: 'online',
      status: 'online',
      chapters: 'online',
      wordCount: 'online',
      series: 'online',
      seriesIndex: 'online',
      efpUrl: 'online',
    },
  };

  await writeBookJsonPublic(folderPath, meta);
  index.push(meta);
  await saveIndex(index);
  notifyBook(currentLibrary(), meta.id, 'new');
  return { book: meta, story, created: true };
}




