import fsp from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { countWords, htmlToText, decodeEntities } from './epub.js';
import type { ExtractedCover } from './epub.js';

export interface GenericInfo {
  title: string;
  subtitle: string;
  authors: string[];
  description: string;
  publisher: string;
  publishedDate: string;
  language: string;
  isbn: string;
  identifiers: Record<string, string>;
  subjects: string[];
  pageCount: number | null;
  wordCount: number;
  charCount: number;
  cover: ExtractedCover | null;
  headText: string;
  infoText: string;
}

/* ------------------------------------------------------------------ PDF -- */

function extractEmbeddedImage(buffer: Buffer): ExtractedCover | null {
  // JPEG: dalla firma SOI a EOI.
  const jpegStart = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpegStart !== -1) {
    const jpegEnd = buffer.indexOf(Buffer.from([0xff, 0xd9]), jpegStart);
    if (jpegEnd !== -1 && jpegEnd - jpegStart > 5000) {
      return { data: buffer.subarray(jpegStart, jpegEnd + 2), ext: '.jpg' };
    }
  }
  // PNG: firma + IEND.
  const pngStart = buffer.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (pngStart !== -1) {
    const pngEnd = buffer.indexOf(Buffer.from('IEND', 'ascii'), pngStart);
    if (pngEnd !== -1) {
      return { data: buffer.subarray(pngStart, pngEnd + 8), ext: '.png' };
    }
  }
  return null;
}

export async function parsePdf(filePath: string): Promise<GenericInfo> {
  const buffer = await fsp.readFile(filePath);
  const empty: GenericInfo = {
    title: '',
    subtitle: '',
    authors: [],
    description: '',
    publisher: '',
    publishedDate: '',
    language: '',
    isbn: '',
    identifiers: {},
    subjects: [],
    pageCount: null,
    wordCount: 0,
    charCount: 0,
    cover: extractEmbeddedImage(buffer),
    headText: '',
    infoText: '',
  };

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;

    empty.pageCount = doc.numPages;
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    empty.title = typeof info.Title === 'string' ? info.Title.trim() : '';
    const author = typeof info.Author === 'string' ? info.Author.trim() : '';
    empty.authors = author ? author.split(/\s*;\s*|\s+and\s+/i).filter(Boolean) : [];
    if (typeof info.Subject === 'string') empty.description = info.Subject.trim();
    if (typeof info.Keywords === 'string') {
      empty.subjects = info.Keywords.split(/\s*,\s*/).filter(Boolean);
    }

    let text = '';
    const maxPages = Math.min(doc.numPages, 300);
    for (let i = 1; i <= maxPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items
        .map((item: any) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      text += '\n';
      page.cleanup();
    }
    empty.wordCount = countWords(text);
    empty.charCount = text.length;
    empty.headText = text.slice(0, 12000);
    await doc.destroy();
  } catch (error) {
    console.warn('[pdf] estrazione parziale:', (error as Error).message);
  }

  return empty;
}

/* ----------------------------------------------------------------- DOCX -- */

export async function parseDocx(filePath: string): Promise<GenericInfo> {
  const zip = new AdmZip(filePath);
  const empty: GenericInfo = {
    title: '',
    subtitle: '',
    authors: [],
    description: '',
    publisher: '',
    publishedDate: '',
    language: '',
    isbn: '',
    identifiers: {},
    subjects: [],
    pageCount: null,
    wordCount: 0,
    charCount: 0,
    cover: null,
    headText: '',
    infoText: '',
  };

  const docEntry = zip.getEntry('word/document.xml');
  if (docEntry) {
    const xml = docEntry.getData().toString('utf8');
    const text = htmlToText(xml.replace(/<w:tab[^>]*\/>/g, ' ').replace(/<w:br[^>]*\/>/g, '\n'));
    empty.wordCount = countWords(text);
    empty.charCount = text.length;
    empty.headText = text.slice(0, 12000);
  }

  const coreEntry = zip.getEntry('docProps/core.xml');
  if (coreEntry) {
    const xml = coreEntry.getData().toString('utf8');
    const pick = (tag: string): string => {
      const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
      return match ? decodeEntities(match[1]).trim() : '';
    };
    empty.title = pick('title');
    const creator = pick('creator');
    if (creator) empty.authors = [creator];
    empty.description = pick('description') || pick('subject');
    empty.publishedDate = pick('created');
  }

  const media = zip.getEntries().filter((e) => /^word\/media\//i.test(e.entryName));
  const image = media.find((e) => /cover/i.test(e.entryName)) ?? media[0];
  if (image) {
    empty.cover = {
      data: image.getData(),
      ext: path.extname(image.entryName).toLowerCase() || '.jpg',
    };
  }

  return empty;
}

/* --------------------------------------------------------- TXT / MD / ... -- */

export async function parsePlain(filePath: string): Promise<GenericInfo> {
  const text = await fsp.readFile(filePath, 'utf8');
  return {
    title: '',
    subtitle: '',
    authors: [],
    description: '',
    publisher: '',
    publishedDate: '',
    language: '',
    isbn: '',
    identifiers: {},
    subjects: [],
    pageCount: null,
    wordCount: countWords(text),
    charCount: text.length,
    cover: null,
    headText: text.slice(0, 12000),
    infoText: text.slice(0, 8000),
  };
}
