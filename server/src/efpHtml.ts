/**
 * Conversione del testo dei capitoli EFP (HTML spesso incollato da Word) in
 * paragrafi formattati, e resa degli stessi in XHTML (EPUB) e ODT.
 *
 * Si conservano solo le formattazioni che fanno parte del testo: grassetto,
 * corsivo, sottolineato, barrato, allineamento (centro/destra), righe vuote
 * volute e separatori di scena (<hr>). Font, dimensioni e colori vengono quasi
 * sempre dall'editor dell'autore e sono ignorati.
 */

export interface EfpRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export type EfpAlign = 'center' | 'right';

export interface EfpParagraph {
  runs: EfpRun[];
  align?: EfpAlign;
  /** Separatore di scena (<hr> nel testo). */
  separator?: boolean;
}

type Format = Omit<EfpRun, 'text'>;

interface Frame {
  tag: string;
  format: Format;
  /** 'left' = allineamento esplicito di default, annulla un centro ereditato. */
  align?: EfpAlign | 'left';
  block: boolean;
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'center', 'blockquote', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'pre',
  'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr', 'col', 'area', 'base']);
const SKIP_TAGS = new Set(['script', 'style', 'xml', 'head', 'title', 'noscript', 'iframe', 'object', 'select']);

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', hellip: '…', ndash: '–', mdash: '—', middot: '·',
  bull: '•', deg: '°', copy: '©', reg: '®', trade: '™', euro: '€', shy: '',
  agrave: 'à', aacute: 'á', egrave: 'è', eacute: 'é', igrave: 'ì', iacute: 'í',
  ograve: 'ò', oacute: 'ó', ugrave: 'ù', uacute: 'ú', Agrave: 'À', Aacute: 'Á',
  Egrave: 'È', Eacute: 'É', Igrave: 'Ì', Iacute: 'Í', Ograve: 'Ò', Oacute: 'Ó',
  Ugrave: 'Ù', Uacute: 'Ú', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û', times: '×',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function attribute(attrs: string, name: string): string {
  const match = attrs.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/** Valore di una proprieta' CSS inline (ignora le varianti "mso-...-font-weight"). */
function cssValue(style: string, property: string): string {
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match ? (match[1] ?? '').trim().toLowerCase() : '';
}

function alignOf(value: string): EfpAlign | 'left' | undefined {
  if (value.startsWith('center') || value === 'middle') return 'center';
  if (value.startsWith('right')) return 'right';
  if (value.startsWith('left') || value.startsWith('justify')) return 'left';
  return undefined;
}

function frameFor(tag: string, attrs: string): Frame {
  const format: Format = {};
  if (tag === 'b' || tag === 'strong') format.bold = true;
  if (/^h[1-6]$/.test(tag)) format.bold = true;
  if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'dfn' || tag === 'var') {
    format.italic = true;
  }
  if (tag === 'u' || tag === 'ins') format.underline = true;
  if (tag === 's' || tag === 'strike' || tag === 'del') format.strike = true;

  const style = attribute(attrs, 'style');
  const weight = cssValue(style, 'font-weight');
  if (/^(bold|bolder|[6-9]00)$/.test(weight)) format.bold = true;
  else if (/^(normal|lighter|[1-5]00)$/.test(weight)) format.bold = false;
  const fontStyle = cssValue(style, 'font-style');
  if (/^(italic|oblique)/.test(fontStyle)) format.italic = true;
  else if (fontStyle === 'normal') format.italic = false;
  const decoration = cssValue(style, 'text-decoration') || cssValue(style, 'text-decoration-line');
  if (decoration) {
    if (decoration.includes('underline')) format.underline = true;
    if (decoration.includes('line-through')) format.strike = true;
    if (decoration.startsWith('none')) {
      format.underline = false;
      format.strike = false;
    }
  }

  const block = BLOCK_TAGS.has(tag);
  let align: Frame['align'];
  if (tag === 'center') align = 'center';
  if (block) {
    align =
      alignOf(cssValue(style, 'text-align')) ??
      alignOf(attribute(attrs, 'align').toLowerCase()) ??
      align;
  }
  return { tag, format, align, block };
}

function sameFormat(left: Format, right: Format): boolean {
  return (
    !!left.bold === !!right.bold &&
    !!left.italic === !!right.italic &&
    !!left.underline === !!right.underline &&
    !!left.strike === !!right.strike
  );
}

export function paragraphText(paragraph: EfpParagraph): string {
  return paragraph.runs.map((run) => run.text).join('');
}

/**
 * Converte l'HTML di un capitolo in paragrafi. `<` e' un tag solo se seguito da
 * una lettera, `/` o `!`: molte autrici scrivono i dialoghi come "<< ... >>" senza
 * entita', e una rimozione ingenua dei tag cancellerebbe le battute.
 */
export function htmlToBlocks(html: string): EfpParagraph[] {
  const raw: EfpParagraph[] = [];
  const stack: Frame[] = [];
  let current: EfpParagraph | null = null;
  /** Il paragrafo corrente contiene un &nbsp;: se resta "vuoto" e' una riga vuota voluta. */
  let currentHasNbsp = false;

  const effective = (): Format => {
    const format: Format = {};
    for (const frame of stack) Object.assign(format, frame.format);
    return format;
  };
  const currentAlign = (): EfpAlign | undefined => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const align = stack[index]!.align;
      if (align) return align === 'left' ? undefined : align;
    }
    return undefined;
  };

  const flush = (keepEmpty: boolean): void => {
    if (current) {
      const runs = current.runs;
      if (runs.length) runs[0]!.text = runs[0]!.text.replace(/^ +/, '');
      if (runs.length) runs[runs.length - 1]!.text = runs[runs.length - 1]!.text.replace(/ +$/, '');
      current.runs = runs.filter((run) => run.text);
      if (current.runs.length) raw.push(current);
      else if (currentHasNbsp) raw.push({ runs: [] });
    } else if (keepEmpty) {
      raw.push({ runs: [] });
    }
    current = null;
    currentHasNbsp = false;
  };

  const addText = (value: string): void => {
    const decoded = decodeHtmlEntities(value).replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f​﻿]/g,
      '',
    );
    const hasNbsp = decoded.includes(' ');
    // Gli spazi ASCII fra un blocco e l'altro non aprono un paragrafo.
    if (!current && !hasNbsp && !/[^\s]/.test(decoded)) return;
    const text = decoded.replace(/[\s ]+/g, ' ');
    if (!current) current = { runs: [], align: currentAlign() };
    if (hasNbsp) currentHasNbsp = true;
    const runs = current.runs;
    const last = runs[runs.length - 1];
    const piece = (!last || last.text.endsWith(' ')) && text.startsWith(' ') ? text.slice(1) : text;
    if (!piece) return;
    const format = effective();
    if (last && sameFormat(last, format)) last.text += piece;
    else runs.push({ text: piece, ...pruneFormat(format) });
  };

  const TOKEN =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?)\/?>/g;
  let position = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(html))) {
    if (match.index > position) addText(html.slice(position, match.index));
    position = match.index + match[0].length;
    const name = match[2]?.toLowerCase();
    if (!name) continue; // commento, doctype, istruzione condizionale di Word
    const closing = match[1] === '/';
    const attrs = match[3] ?? '';

    if (!closing && SKIP_TAGS.has(name)) {
      const end = html.toLowerCase().indexOf(`</${name}`, position);
      if (end === -1) {
        position = html.length;
        break;
      }
      const close = html.indexOf('>', end);
      position = close === -1 ? html.length : close + 1;
      TOKEN.lastIndex = position;
      continue;
    }

    if (name === 'br') {
      flush(true);
      continue;
    }
    if (name === 'hr') {
      flush(false);
      raw.push({ runs: [], separator: true });
      continue;
    }
    if (VOID_TAGS.has(name)) continue;

    if (closing) {
      const index = stack.map((frame) => frame.tag).lastIndexOf(name);
      if (index === -1) continue;
      const closesBlock = stack.slice(index).some((frame) => frame.block);
      if (closesBlock) flush(false);
      stack.length = index;
      continue;
    }

    const frame = frameFor(name, attrs);
    if (frame.block) flush(false);
    stack.push(frame);
  }
  if (position < html.length) addText(html.slice(position));
  flush(false);

  return tidyBlankLines(raw);
}

function pruneFormat(format: Format): Format {
  const result: Format = {};
  if (format.bold) result.bold = true;
  if (format.italic) result.italic = true;
  if (format.underline) result.underline = true;
  if (format.strike) result.strike = true;
  return result;
}

/**
 * Righe vuote: si tolgono quelle in testa e in coda e si riducono le sequenze a
 * una sola. Se il testo mette una riga vuota fra quasi tutti i paragrafi
 * (classico "<br><br>"), e' solo spaziatura e si eliminano: i paragrafi sono
 * gia' distanziati. Altrimenti sono volute (strofe, stacchi) e si tengono.
 */
function tidyBlankLines(raw: EfpParagraph[]): EfpParagraph[] {
  const isBlank = (paragraph: EfpParagraph): boolean =>
    !paragraph.separator && paragraph.runs.length === 0;
  const collapsed: EfpParagraph[] = [];
  for (const paragraph of raw) {
    const previous = collapsed[collapsed.length - 1];
    if (isBlank(paragraph) && (!previous || isBlank(previous) || previous.separator)) continue;
    if (paragraph.separator && previous && isBlank(previous)) collapsed.pop();
    collapsed.push(paragraph);
  }
  while (collapsed.length && isBlank(collapsed[collapsed.length - 1]!)) collapsed.pop();

  const blanks = collapsed.filter(isBlank).length;
  const texts = collapsed.filter((paragraph) => paragraph.runs.length).length;
  if (blanks && blanks >= texts * 0.5) return collapsed.filter((paragraph) => !isBlank(paragraph));
  return collapsed;
}

/* ------------------------------------------------------------------ resa -- */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const EPUB_TEXT_CSS = `p.center { text-align: center; }
p.right { text-align: right; }
p.blank { margin: 0; }
p.scene { text-align: center; margin: 1.2em 0; }
.u { text-decoration: underline; }
.s { text-decoration: line-through; }
.u.s { text-decoration: underline line-through; }
`;

function runXhtml(run: EfpRun): string {
  let html = escapeXml(run.text);
  const classes = [run.underline ? 'u' : '', run.strike ? 's' : ''].filter(Boolean);
  if (classes.length) html = `<span class="${classes.join(' ')}">${html}</span>`;
  if (run.italic) html = `<em>${html}</em>`;
  if (run.bold) html = `<strong>${html}</strong>`;
  return html;
}

export function blocksToXhtml(paragraphs: EfpParagraph[], indent = '      '): string {
  return paragraphs
    .map((paragraph) => {
      if (paragraph.separator) return `${indent}<p class="scene">* * *</p>`;
      if (!paragraph.runs.length) return `${indent}<p class="blank">&#160;</p>`;
      const cls = paragraph.align ? ` class="${paragraph.align}"` : '';
      return `${indent}<p${cls}>${paragraph.runs.map(runXhtml).join('')}</p>`;
    })
    .join('\n');
}

/** Raccoglie gli stili automatici ODT necessari ai paragrafi resi. */
export class OdtTextStyles {
  private readonly spans = new Set<string>();

  spanStyle(run: EfpRun): string {
    const key = `${run.bold ? 'B' : ''}${run.italic ? 'I' : ''}${run.underline ? 'U' : ''}${run.strike ? 'S' : ''}`;
    if (!key) return '';
    this.spans.add(key);
    return `T_${key}`;
  }

  /** Stili di paragrafo (centro/destra/riga vuota) e di testo usati. */
  xml(): string {
    const paragraphStyles = `    <style:style style:name="P_center" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:margin-bottom="0.25cm" fo:text-align="center"/>
    </style:style>
    <style:style style:name="P_right" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:margin-bottom="0.25cm" fo:text-align="end"/>
    </style:style>
    <style:style style:name="P_blank" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:margin-bottom="0cm"/>
    </style:style>
    <style:style style:name="P_scene" style:family="paragraph" style:parent-style-name="Standard">
      <style:paragraph-properties fo:margin-top="0.4cm" fo:margin-bottom="0.4cm" fo:text-align="center"/>
    </style:style>`;
    const spanStyles = [...this.spans]
      .map((key) => {
        const props = [
          key.includes('B') ? 'fo:font-weight="bold"' : '',
          key.includes('I') ? 'fo:font-style="italic"' : '',
          key.includes('U')
            ? 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"'
            : '',
          key.includes('S') ? 'style:text-line-through-style="solid"' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `    <style:style style:name="T_${key}" style:family="text">
      <style:text-properties ${props}/>
    </style:style>`;
      })
      .join('\n');
    return spanStyles ? `${paragraphStyles}\n${spanStyles}` : paragraphStyles;
  }
}

export function blocksToOdt(paragraphs: EfpParagraph[], styles: OdtTextStyles): string {
  return paragraphs
    .map((paragraph) => {
      if (paragraph.separator) return '<text:p text:style-name="P_scene">* * *</text:p>';
      if (!paragraph.runs.length) return '<text:p text:style-name="P_blank"/>';
      const styleName =
        paragraph.align === 'center' ? 'P_center' : paragraph.align === 'right' ? 'P_right' : 'Text_20_body';
      const body = paragraph.runs
        .map((run) => {
          const span = styles.spanStyle(run);
          const text = escapeXml(run.text);
          return span ? `<text:span text:style-name="${span}">${text}</text:span>` : text;
        })
        .join('');
      return `<text:p text:style-name="${styleName}">${body}</text:p>`;
    })
    .join('\n');
}
