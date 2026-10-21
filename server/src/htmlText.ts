import { decodeHtmlEntities } from './efpHtml.js';

/** Un vero tag HTML: "<" seguito da lettera, "/" o "!". "<< battuta >>" resta testo. */
const TAG = /<\/?[a-zA-Z!][^<>]*>/;

/** La stringa contiene tag HTML o entita' (&amp;, &#8217;...) da convertire. */
export function looksLikeHtml(value: string): boolean {
  return TAG.test(value) || /&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/i.test(value);
}

/**
 * Converte una descrizione HTML (EPUB di Calibre, Google Books, editori...) in
 * testo semplice: i blocchi diventano paragrafi separati da una riga vuota, i
 * <br> a capo, le voci di elenco righe con "•". Il testo senza HTML resta
 * invariato.
 */
export function htmlToText(value: string | null | undefined): string {
  if (!value) return '';
  if (!looksLikeHtml(value)) return value.trim();

  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    // Gli a capo nel sorgente HTML sono solo spazi.
    .replace(/\s*\n\s*/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(
      /<\/?(p|div|h[1-6]|blockquote|ul|ol|section|article|header|footer|table|tr|pre|hr)\b[^>]*>/gi,
      '\n\n',
    )
    .replace(/<\/?[a-zA-Z!][^<>]*>/g, '');

  return decodeHtmlEntities(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
