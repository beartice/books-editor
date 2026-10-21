import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BookMeta } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { cn } from '../utils';
import {
  IconClose,
  IconDownload,
  IconImage,
  IconSparkle,
  IconTrash,
  IconUpload,
} from './icons';

/* --------------------------------------------------------------- modello -- */

type Template = 'bands' | 'frame' | 'block' | 'image';
type Typeface = 'serif' | 'editorial' | 'sans';
type LogoStyle = 'penguin' | 'ornament' | 'monogram' | 'none';
type ExportFormat = 'jpeg' | 'png';

interface CoverDesign {
  title: string;
  author: string;
  kicker: string;
  series: string;
  imprint: string;
  template: Template;
  paletteId: string;
  paper: string;
  accent: string;
  typeface: Typeface;
  logo: LogoStyle;
  format: ExportFormat;
  imageDataUrl: string | null;
  imageName: string;
}

const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 1800;
const EXPORT_WIDTH = 1600;
const EXPORT_HEIGHT = 2400;

const TYPEFACES: Record<Typeface, { label: string; family: string }> = {
  serif: {
    label: 'Serif classico',
    family: "Georgia, 'Times New Roman', serif",
  },
  editorial: {
    label: 'Serif elegante',
    family: "'Didot', 'Bodoni MT', 'Baskerville', 'Iowan Old Style', Georgia, serif",
  },
  sans: {
    label: 'Sans moderno',
    family: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
};

const PALETTES = [
  { id: 'orange', label: 'Classico arancio', paper: '#F3E7CF', accent: '#E75A2A' },
  { id: 'paper', label: 'Carta e inchiostro', paper: '#EFE5D2', accent: '#22211E' },
  { id: 'black', label: 'Nero e oro', paper: '#171513', accent: '#D4AF72' },
  { id: 'green', label: 'Verde bosco', paper: '#DDE3D0', accent: '#2F5B4A' },
  { id: 'blue', label: 'Blu notte', paper: '#DCE4EA', accent: '#244D73' },
  { id: 'burgundy', label: 'Bordeaux', paper: '#EDDFD1', accent: '#7A2F38' },
  { id: 'yellow', label: 'Giallo Penguin', paper: '#F4E3A1', accent: '#1B1B19' },
];

const TEMPLATES: { id: Template; label: string }[] = [
  { id: 'bands', label: 'Bande' },
  { id: 'frame', label: 'Cornice' },
  { id: 'block', label: 'Moderno' },
  { id: 'image', label: 'Immagine' },
];

const LOGOS: { id: LogoStyle; label: string }[] = [
  { id: 'penguin', label: 'Pinguino' },
  { id: 'ornament', label: 'Ornamento' },
  { id: 'monogram', label: 'Monogramma' },
  { id: 'none', label: 'Nessuno' },
];

/* --------------------------------------------------------------- colori -- */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((part) => part + part)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return { r: 0, g: 0, b: 0 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Testo leggibile sopra un colore pieno. */
function readableOn(background: string): string {
  return relativeLuminance(background) > 0.4 ? '#1D1B18' : '#F8EFDF';
}

/* ----------------------------------------------------------- svg helpers -- */

let measureContext: CanvasRenderingContext2D | null | undefined;

function measureText(text: string, family: string, weight: number, size: number): number {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  if (!measureContext) return text.length * size * 0.56;
  measureContext.font = `${weight} ${size}px ${family}`;
  return measureContext.measureText(text).width;
}

function splitLongWord(
  word: string,
  maxWidth: number,
  family: string,
  weight: number,
  size: number,
): string[] {
  const parts: string[] = [];
  let rest = word;
  while (rest.length > 0) {
    let index = rest.length;
    while (index > 1 && measureText(rest.slice(0, index), family, weight, size) > maxWidth) {
      index -= 1;
    }
    parts.push(rest.slice(0, index));
    rest = rest.slice(index);
  }
  return parts;
}

function wrapText(
  text: string,
  maxWidth: number,
  family: string,
  weight: number,
  size: number,
): string[] {
  const output: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      output.push('');
      continue;
    }

    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, family, weight, size) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) {
        output.push(line);
        line = '';
      }

      if (measureText(word, family, weight, size) > maxWidth) {
        const chunks = splitLongWord(word, maxWidth, family, weight, size);
        output.push(...chunks.slice(0, -1));
        line = chunks[chunks.length - 1] ?? '';
      } else {
        line = word;
      }
    }
    if (line) output.push(line);
  }
  return output;
}

interface FittedBlock {
  lines: string[];
  size: number;
  lineHeight: number;
}

function fitBlock(options: {
  text: string;
  maxWidth: number;
  maxHeight: number;
  maxSize: number;
  minSize: number;
  family: string;
  weight: number;
  lineHeight?: number;
  uppercase?: boolean;
}): FittedBlock {
  const lineHeight = options.lineHeight ?? 1.12;
  const text = options.uppercase ? options.text.toLocaleUpperCase('it-IT') : options.text;
  let size = options.maxSize;
  while (size >= options.minSize) {
    const lines = wrapText(text, options.maxWidth, options.family, options.weight, size);
    if (lines.length * size * lineHeight <= options.maxHeight) {
      return { lines, size, lineHeight };
    }
    size -= 2;
  }
  return {
    lines: wrapText(text, options.maxWidth, options.family, options.weight, options.minSize),
    size: options.minSize,
    lineHeight,
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function svgText(
  text: string,
  x: number,
  y: number,
  options: {
    size: number;
    family: string;
    weight?: number;
    fill: string;
    opacity?: number;
    anchor?: 'start' | 'middle' | 'end';
    letterSpacing?: number;
    italic?: boolean;
  },
): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${options.fill}" opacity="${
    options.opacity ?? 1
  }" font-family="${options.family}" font-size="${options.size}" font-weight="${
    options.weight ?? 400
  }" font-style="${options.italic ? 'italic' : 'normal'}" text-anchor="${
    options.anchor ?? 'middle'
  }" letter-spacing="${options.letterSpacing ?? 0}">${escapeXml(text)}</text>`;
}

function renderBlock(
  block: FittedBlock,
  x: number,
  centerY: number,
  options: {
    family: string;
    weight: number;
    fill: string;
    opacity?: number;
    letterSpacing?: number;
    italic?: boolean;
  },
): string {
  const step = block.size * block.lineHeight;
  const firstBaseline = centerY - ((block.lines.length - 1) * step) / 2 + block.size * 0.34;
  return block.lines
    .map((line, index) =>
      svgText(line, x, firstBaseline + index * step, {
        size: block.size,
        family: options.family,
        weight: options.weight,
        fill: options.fill,
        opacity: options.opacity,
        letterSpacing: options.letterSpacing,
        italic: options.italic,
      }),
    )
    .join('');
}

function flourish(cx: number, cy: number, width: number, color: string, opacity = 1): string {
  const gap = 24;
  return `<g stroke="${color}" stroke-width="1.6" fill="none" opacity="${opacity}">
    <path d="M${cx - width / 2} ${cy} H${cx - gap}" />
    <path d="M${cx + gap} ${cy} H${cx + width / 2}" />
    <path d="M${cx} ${cy - 7} L${cx + 7} ${cy} L${cx} ${cy + 7} L${
      cx - 7
    } ${cy} Z" fill="${color}" stroke="none" />
  </g>`;
}

function initialsOf(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'PC';
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase('it-IT');
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toLocaleUpperCase('it-IT');
}

function splitBrand(value: string): [string, string] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [value.trim(), ''];
  const middle = Math.ceil(words.length / 2);
  return [words.slice(0, middle).join(' '), words.slice(middle).join(' ')];
}

function logoMark(
  style: LogoStyle,
  cx: number,
  cy: number,
  diameter: number,
  accent: string,
  paper: string,
  monogram: string,
): string {
  if (style === 'none') return '';
  const scale = diameter / 140;
  if (style === 'penguin') {
    return `<g transform="translate(${cx} ${cy}) scale(${scale})">
      <circle cx="0" cy="0" r="70" fill="#F7EEDC" stroke="${accent}" stroke-width="2.5" />
      <ellipse cx="-31" cy="16" rx="9" ry="25" fill="#1C1B18" transform="rotate(17 -31 16)" />
      <ellipse cx="31" cy="16" rx="9" ry="25" fill="#1C1B18" transform="rotate(-17 31 16)" />
      <ellipse cx="0" cy="13" rx="33" ry="46" fill="#1C1B18" />
      <ellipse cx="0" cy="22" rx="20" ry="31" fill="#F7EEDC" />
      <circle cx="0" cy="-31" r="23" fill="#1C1B18" />
      <ellipse cx="-7" cy="-34" rx="3.2" ry="4.3" fill="#F7EEDC" />
      <ellipse cx="7" cy="-34" rx="3.2" ry="4.3" fill="#F7EEDC" />
      <circle cx="-7" cy="-34" r="1.4" fill="#1C1B18" />
      <circle cx="7" cy="-34" r="1.4" fill="#1C1B18" />
      <path d="M0 -32 L14 -26 L0 -20 Z" fill="${accent}" />
      <ellipse cx="-19" cy="55" rx="11" ry="4.5" fill="${accent}" />
      <ellipse cx="19" cy="55" rx="11" ry="4.5" fill="${accent}" />
    </g>`;
  }

  if (style === 'ornament') {
    return `<g transform="translate(${cx} ${cy}) scale(${scale})" stroke="${accent}" fill="none">
      <circle cx="0" cy="0" r="55" stroke-width="1.4" opacity=".55" />
      <path d="M0 -43 L8 -9 L42 0 L8 9 L0 43 L-8 9 L-42 0 L-8 -9 Z" fill="${accent}" stroke="none" />
      <circle cx="0" cy="0" r="8" fill="${paper}" stroke="none" />
      <path d="M-68 0 H-50 M50 0 H68" stroke-width="1.6" />
    </g>`;
  }

  return `<g transform="translate(${cx} ${cy}) scale(${scale})">
    <circle cx="0" cy="0" r="70" fill="${paper}" stroke="${accent}" stroke-width="2.5" />
    <circle cx="0" cy="0" r="59" fill="none" stroke="${accent}" stroke-width="1" opacity=".55" />
    <text x="0" y="17" fill="${accent}" font-family="${TYPEFACES.editorial.family}" font-size="48" font-weight="600" text-anchor="middle" letter-spacing="2">${escapeXml(
      monogram,
    )}</text>
  </g>`;
}

/* ------------------------------------------------------------ generatore -- */

function buildCoverSvg(design: CoverDesign, width = VIEW_WIDTH, height = VIEW_HEIGHT): string {
  const typeface = TYPEFACES[design.typeface].family;
  const paper = design.paper;
  const accent = design.accent;
  const ink = readableOn(paper);
  const onAccent = readableOn(accent);
  const detail = contrastRatio(accent, paper) >= 2.2 ? accent : ink;
  const monogram = initialsOf(design.author || design.title);

  const imprintBlock = fitBlock({
    text: design.imprint,
    maxWidth: 900,
    maxHeight: 45,
    maxSize: 27,
    minSize: 17,
    family: typeface,
    weight: 600,
    uppercase: true,
  });
  const kickerBlock = fitBlock({
    text: design.kicker,
    maxWidth: 820,
    maxHeight: 55,
    maxSize: 25,
    minSize: 16,
    family: typeface,
    weight: 600,
    uppercase: true,
    lineHeight: 1.25,
  });
  const seriesBlock = fitBlock({
    text: design.series,
    maxWidth: 860,
    maxHeight: 92,
    maxSize: 28,
    minSize: 18,
    family: typeface,
    weight: 500,
    lineHeight: 1.25,
  });

  const authorBlock = fitBlock({
    text: design.author,
    maxWidth: 900,
    maxHeight: 120,
    maxSize: 39,
    minSize: 24,
    family: typeface,
    weight: 600,
    uppercase: true,
    lineHeight: 1.12,
  });

  let layers = '';

  if (design.template === 'bands') {
    const titleBlock = fitBlock({
      text: design.title,
      maxWidth: 880,
      maxHeight: 500,
      maxSize: 132,
      minSize: 42,
      family: typeface,
      weight: 600,
      lineHeight: 1.04,
    });

    layers = `
      <rect width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" fill="${paper}" />
      <rect width="${VIEW_WIDTH}" height="230" fill="${accent}" />
      <rect y="1500" width="${VIEW_WIDTH}" height="300" fill="${accent}" />
      ${renderBlock(imprintBlock, VIEW_WIDTH / 2, 112, {
        family: typeface,
        weight: 600,
        fill: onAccent,
        letterSpacing: 9,
      })}
      ${logoMark(design.logo, VIEW_WIDTH / 2, 365, 152, accent, paper, monogram)}
      ${renderBlock(kickerBlock, VIEW_WIDTH / 2, 520, {
        family: typeface,
        weight: 600,
        fill: detail,
        letterSpacing: 5,
      })}
      ${renderBlock(titleBlock, VIEW_WIDTH / 2, 825, {
        family: typeface,
        weight: 600,
        fill: ink,
      })}
      ${flourish(VIEW_WIDTH / 2, 1115, 220, accent)}
      ${renderBlock(seriesBlock, VIEW_WIDTH / 2, 1195, {
        family: typeface,
        weight: 500,
        fill: detail,
        italic: false,
      })}
      ${renderBlock(authorBlock, VIEW_WIDTH / 2, 1650, {
        family: typeface,
        weight: 600,
        fill: onAccent,
        letterSpacing: 4,
      })}
    `;
  } else if (design.template === 'frame') {
    const titleBlock = fitBlock({
      text: design.title,
      maxWidth: 860,
      maxHeight: 500,
      maxSize: 126,
      minSize: 42,
      family: typeface,
      weight: 600,
      lineHeight: 1.04,
    });

    layers = `
      <rect width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" fill="${paper}" />
      <rect x="18" y="18" width="1164" height="1764" fill="none" stroke="${accent}" stroke-width="17" />
      <rect x="50" y="50" width="1100" height="1700" fill="none" stroke="${accent}" stroke-width="2.5" />
      ${renderBlock(imprintBlock, VIEW_WIDTH / 2, 125, {
        family: typeface,
        weight: 600,
        fill: detail,
        letterSpacing: 9,
      })}
      ${logoMark(design.logo, VIEW_WIDTH / 2, 340, 146, accent, paper, monogram)}
      ${renderBlock(kickerBlock, VIEW_WIDTH / 2, 490, {
        family: typeface,
        weight: 600,
        fill: detail,
        letterSpacing: 5,
      })}
      ${renderBlock(titleBlock, VIEW_WIDTH / 2, 810, {
        family: typeface,
        weight: 600,
        fill: ink,
      })}
      ${flourish(VIEW_WIDTH / 2, 1095, 200, accent)}
      ${renderBlock(seriesBlock, VIEW_WIDTH / 2, 1170, {
        family: typeface,
        weight: 500,
        fill: detail,
      })}
      <rect x="50" y="1465" width="1100" height="285" fill="${accent}" />
      ${flourish(VIEW_WIDTH / 2, 1530, 150, onAccent, 0.55)}
      ${renderBlock(authorBlock, VIEW_WIDTH / 2, 1630, {
        family: typeface,
        weight: 600,
        fill: onAccent,
        letterSpacing: 4,
      })}
    `;
  } else if (design.template === 'block') {
    const titleBlock = fitBlock({
      text: design.title,
      maxWidth: 900,
      maxHeight: 520,
      maxSize: 148,
      minSize: 44,
      family: typeface,
      weight: 600,
      lineHeight: 1.02,
    });

    layers = `
      <rect width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" fill="${paper}" />
      <rect width="${VIEW_WIDTH}" height="1200" fill="${accent}" />
      <rect x="42" y="42" width="1116" height="1116" fill="none" stroke="${onAccent}" stroke-width="1.5" opacity=".28" />
      ${renderBlock(kickerBlock, VIEW_WIDTH / 2, 195, {
        family: typeface,
        weight: 600,
        fill: onAccent,
        opacity: 0.78,
        letterSpacing: 5,
      })}
      ${renderBlock(titleBlock, VIEW_WIDTH / 2, 690, {
        family: typeface,
        weight: 600,
        fill: onAccent,
      })}
      ${flourish(VIEW_WIDTH / 2, 1000, 220, onAccent, 0.72)}
      ${renderBlock(seriesBlock, VIEW_WIDTH / 2, 1075, {
        family: typeface,
        weight: 500,
        fill: onAccent,
        opacity: 0.82,
      })}
      ${
        design.logo === 'none'
          ? `<path d="M380 1200 H820" stroke="${accent}" stroke-width="2" />`
          : `<circle cx="${VIEW_WIDTH / 2}" cy="1200" r="88" fill="${paper}" />${logoMark(
              design.logo,
              VIEW_WIDTH / 2,
              1200,
              154,
              accent,
              paper,
              monogram,
            )}`
      }
      ${renderBlock(authorBlock, VIEW_WIDTH / 2, 1430, {
        family: typeface,
        weight: 600,
        fill: ink,
        letterSpacing: 4,
      })}
      ${flourish(VIEW_WIDTH / 2, 1545, 180, accent, 0.7)}
      ${renderBlock(imprintBlock, VIEW_WIDTH / 2, 1640, {
        family: typeface,
        weight: 600,
        fill: detail,
        letterSpacing: 9,
      })}
    `;
  } else {
    const imageHeight = 1248;
    const brandHeight = 88;
    const brandTop = imageHeight;
    const footerTop = brandTop + brandHeight;
    const footerHeight = VIEW_HEIGHT - footerTop;
    const brandPaper = '#FFFFFF';
    const brandInk = '#11100E';
    const footerBackground = '#0D0C0B';
    const footerInk = '#F8F3E9';
    const footerAccent =
      contrastRatio(accent, footerBackground) >= 2.2 ? accent : '#E75A2A';

    const imageAuthorBlock = fitBlock({
      text: design.author,
      maxWidth: 900,
      maxHeight: 70,
      maxSize: 52,
      minSize: 16,
      family: TYPEFACES.sans.family,
      weight: 500,
      uppercase: true,
      lineHeight: 1.12,
    });
    const imageTitleBlock = fitBlock({
      text: design.title,
      maxWidth: 900,
      maxHeight: 130,
      maxSize: 62,
      minSize: 20,
      family: typeface,
      weight: 400,
      lineHeight: 1.12,
    });
    const imageSubtitleBlock = fitBlock({
      text: design.series,
      maxWidth: 880,
      maxHeight: 72,
      maxSize: 32,
      minSize: 16,
      family: typeface,
      weight: 400,
      lineHeight: 1.2,
    });
    const titleHalfHeight =
      (imageTitleBlock.lines.length * imageTitleBlock.size * imageTitleBlock.lineHeight) / 2;
    const subtitleHalfHeight =
      (imageSubtitleBlock.lines.length * imageSubtitleBlock.size * imageSubtitleBlock.lineHeight) / 2;
    const subtitleCenter = Math.min(
      1720,
      Math.max(1660, 1590 + titleHalfHeight + 28 + subtitleHalfHeight),
    );

    const [brandLeft, brandRight] = splitBrand(design.imprint);
    const brandLeftBlock = fitBlock({
      text: brandLeft,
      maxWidth: 300,
      maxHeight: 46,
      maxSize: 25,
      minSize: 13,
      family: TYPEFACES.sans.family,
      weight: 700,
      uppercase: true,
      lineHeight: 1,
    });
    const brandRightBlock = fitBlock({
      text: brandRight,
      maxWidth: 300,
      maxHeight: 46,
      maxSize: 25,
      minSize: 13,
      family: TYPEFACES.sans.family,
      weight: 700,
      uppercase: true,
      lineHeight: 1,
    });

    layers = `
      <rect width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" fill="${brandPaper}" />
      ${
        design.imageDataUrl
          ? `<image x="0" y="0" width="${VIEW_WIDTH}" height="${imageHeight}" preserveAspectRatio="xMidYMid slice" href="${escapeXml(
              design.imageDataUrl,
            )}" />`
          : `<rect width="${VIEW_WIDTH}" height="${imageHeight}" fill="${accent}" />`
      }
      <rect y="${brandTop}" width="${VIEW_WIDTH}" height="${brandHeight}" fill="${brandPaper}" />
      <rect y="${footerTop}" width="${VIEW_WIDTH}" height="${footerHeight}" fill="${footerBackground}" />
      ${renderBlock(brandLeftBlock, 384, brandTop + brandHeight / 2, {
        family: TYPEFACES.sans.family,
        weight: 700,
        fill: brandInk,
        letterSpacing: 26,
      })}
      ${renderBlock(brandRightBlock, 813, brandTop + brandHeight / 2, {
        family: TYPEFACES.sans.family,
        weight: 700,
        fill: brandInk,
        letterSpacing: 26,
      })}
      ${logoMark(
        design.logo,
        VIEW_WIDTH / 2,
        brandTop + brandHeight / 2,
        64,
        accent,
        brandPaper,
        monogram,
      )}
      ${renderBlock(imageAuthorBlock, VIEW_WIDTH / 2, 1486, {
        family: TYPEFACES.sans.family,
        weight: 500,
        fill: footerAccent,
        letterSpacing: 6,
      })}
      ${renderBlock(imageTitleBlock, VIEW_WIDTH / 2, 1590, {
        family: typeface,
        weight: 400,
        fill: footerInk,
        italic: true,
      })}
      ${renderBlock(imageSubtitleBlock, VIEW_WIDTH / 2, subtitleCenter, {
        family: typeface,
        weight: 400,
        fill: footerInk,
        opacity: 0.82,
        italic: true,
      })}
    `;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}">${layers}</svg>`;
}

/* --------------------------------------------------------------- utility -- */

function initialDesign(meta: BookMeta): CoverDesign {
  const palette = PALETTES[0];
  const series = [meta.series, meta.fandom].filter(Boolean).join(' · ');
  return {
    title: meta.title || 'Senza titolo',
    author: meta.authors.join(', '),
    kicker: meta.kind === 'fanfic' ? 'A FANFICTION' : '',
    series,
    imprint: 'PENGUIN CLASSICS',
    template: 'bands',
    paletteId: palette.id,
    paper: palette.paper,
    accent: palette.accent,
    typeface: 'editorial',
    logo: 'penguin',
    format: 'jpeg',
    imageDataUrl: null,
    imageName: '',
  };
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 52) || 'copertina'
  );
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error('Il file selezionato non può essere letto come immagine'));
    image.src = src;
  });
}

async function prepareCoverImage(file: File): Promise<{ dataUrl: string; name: string }> {
  const looksLikeImage =
    file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|svg)$/i.test(file.name);
  if (!looksLikeImage) {
    throw new Error('Seleziona un file immagine (JPG, PNG o WebP)');
  }

  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Impossibile leggere l’immagine selezionata'));
    };
    reader.onerror = () => reject(new Error('Impossibile leggere l’immagine selezionata'));
    reader.readAsDataURL(file);
  });

  const image = await loadImageElement(raw);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error('L’immagine selezionata non ha dimensioni valide');

  const maxSide = 2400;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (scale === 1 && file.size <= 2.5 * 1024 * 1024 && !isSvg && file.type.startsWith('image/')) {
    return { dataUrl: raw, name: file.name };
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Impossibile preparare l’immagine in questo browser');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const outputType =
    file.type === 'image/png' || isSvg || /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg';
  return {
    dataUrl: canvas.toDataURL(outputType, outputType === 'image/jpeg' ? 0.92 : undefined),
    name: file.name,
  };
}

async function renderCoverBlob(design: CoverDesign): Promise<Blob> {
  await document.fonts.ready;
  const svg = buildCoverSvg(design, EXPORT_WIDTH, EXPORT_HEIGHT);
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Impossibile generare l’immagine della copertina'));
      image.src = svgUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = EXPORT_WIDTH;
    canvas.height = EXPORT_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas non disponibile in questo browser');
    context.fillStyle = design.paper;
    context.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);

    const mime = design.format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, design.format === 'jpeg' ? 0.94 : undefined),
    );
    if (!blob) throw new Error('Esportazione della copertina non riuscita');
    return blob;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/* --------------------------------------------------------------- component -- */

interface Props {
  meta: BookMeta;
  onClose: () => void;
}

export default function CoverEditor({ meta, onClose }: Props) {
  const reloadBook = useStore((state) => state.reloadBook);
  const toast = useStore((state) => state.toast);
  const [design, setDesign] = useState<CoverDesign>(() => initialDesign(meta));
  const [busy, setBusy] = useState<'save' | 'download' | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy !== null || imageBusy;
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const svg = useMemo(() => buildCoverSvg(design), [design]);
  const [previewUrl, setPreviewUrl] = useState(() => svgDataUrl(svg));
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [svg]);

  const update = <K extends keyof CoverDesign>(key: K, value: CoverDesign[K]) => {
    setDesign((current) => ({ ...current, [key]: value }));
  };

  const loadCoverImage = async (file: File) => {
    if (imageBusy) return;
    setImageBusy(true);
    try {
      const image = await prepareCoverImage(file);
      setDesign((current) => ({
        ...current,
        template: 'image',
        imageDataUrl: image.dataUrl,
        imageName: image.name,
      }));
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setImageBusy(false);
    }
  };

  const applyPalette = (paletteId: string) => {
    const palette = PALETTES.find((item) => item.id === paletteId);
    if (!palette) return;
    setDesign((current) => ({
      ...current,
      paletteId: palette.id,
      paper: palette.paper,
      accent: palette.accent,
    }));
  };

  const makeFile = async () => {
    const blob = await renderCoverBlob(design);
    const extension = design.format === 'png' ? 'png' : 'jpg';
    return new File([blob], `copertina-${slugify(design.title)}.${extension}`, {
      type: blob.type,
    });
  };

  const save = async () => {
    setBusy('save');
    try {
      const file = await makeFile();
      await api.uploadCover(meta.id, file);
      await reloadBook(meta.id);
      toast('Copertina creata e salvata', 'success');
      onClose();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy('download');
    try {
      const file = await makeFile();
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1200);
      toast('Copertina scaricata', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/35 backdrop-blur-[3px]"
        onClick={() => {
          if (!busy && !imageBusy) onClose();
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cover-editor-title"
        className="relative flex h-[100dvh] w-full max-w-6xl animate-scale-in flex-col overflow-hidden border-black/[0.07] bg-white/95 shadow-panel backdrop-blur-xl sm:h-[94vh] sm:max-h-[900px] sm:rounded-2xl sm:border"
      >
        <header className="flex items-center justify-between gap-4 border-b border-black/[0.06] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/15 text-accent-600 ring-1 ring-inset ring-accent-400/20">
              <IconSparkle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id="cover-editor-title" className="truncate text-base font-semibold text-ink-50">
                Copertina Penguin
              </h2>
              <p className="truncate text-[11px] text-ink-500">
                {meta.title} · {meta.authors.join(', ') || 'autore sconosciuto'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-subtle h-10 w-10 shrink-0 px-0 sm:h-auto sm:w-auto sm:px-2"
            aria-label="Chiudi editor copertina"
            disabled={busy !== null || imageBusy}
          >
            <IconClose />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_420px]">
          <div className="relative hidden min-h-0 items-center justify-center overflow-hidden bg-[#e9e3d7] p-8 md:flex">
            <div className="pointer-events-none absolute h-80 w-80 rounded-full bg-accent-500/10 blur-3xl" />
            <div className="relative w-full max-w-[350px]">
              <div className="overflow-hidden rounded-r-xl rounded-l-sm bg-ink-800 shadow-[0_28px_70px_-18px_rgba(54,47,32,.45)] ring-1 ring-black/[0.08]">
                <img
                  src={previewUrl}
                  alt="Anteprima della copertina"
                  draggable={false}
                  className="block h-auto w-full select-none"
                />
              </div>
              <span className="pointer-events-none absolute inset-y-0 left-0 w-3 rounded-l-sm bg-gradient-to-r from-black/30 to-transparent" />
            </div>
            <p className="absolute bottom-4 left-0 right-0 text-center text-[11px] text-ink-500">
              Anteprima · esportazione {EXPORT_WIDTH} × {EXPORT_HEIGHT} px
            </p>
          </div>

          <aside className="min-h-0 overflow-y-auto border-t border-black/[0.06] bg-[#fbf9f4] p-4 sm:p-5 md:border-l md:border-t-0">
            <div className="mx-auto mb-5 w-40 md:hidden">
              <div className="overflow-hidden rounded-r-lg rounded-l-sm bg-ink-800 shadow-lift ring-1 ring-black/[0.08]">
                <img src={previewUrl} alt="Anteprima della copertina" className="block w-full" />
              </div>
            </div>

            <div className="space-y-5">
              <EditorSection
                title="Testo"
                hint={
                  design.template === 'image'
                    ? 'La testatina viene divisa ai lati del logo. Lascia vuoto un campo per non stamparlo.'
                    : 'Lascia vuoto un campo per non stamparlo sulla copertina.'
                }
              >
                <label className="block">
                  <span className="field-label">Titolo</span>
                  <textarea
                    rows={3}
                    maxLength={240}
                    value={design.title}
                    onChange={(event) => update('title', event.target.value)}
                    className="field-input resize-none leading-snug"
                  />
                </label>
                <label className="block">
                  <span className="field-label">Autore</span>
                  <input
                    value={design.author}
                    maxLength={160}
                    onChange={(event) => update('author', event.target.value)}
                    placeholder="Autore o pseudonimo"
                    className="field-input"
                  />
                </label>
                {design.template !== 'image' ? (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="field-label">Occhiello</span>
                      <input
                        value={design.kicker}
                        maxLength={80}
                        onChange={(event) => update('kicker', event.target.value)}
                        placeholder="A FANFICTION"
                        className="field-input"
                      />
                    </label>
                    <label className="block">
                      <span className="field-label">Testatina</span>
                      <input
                        value={design.imprint}
                        maxLength={60}
                        onChange={(event) => update('imprint', event.target.value)}
                        placeholder="PENGUIN CLASSICS"
                        className="field-input"
                      />
                    </label>
                  </div>
                ) : (
                  <label className="block">
                    <span className="field-label">Testatina</span>
                    <input
                      value={design.imprint}
                      maxLength={60}
                      onChange={(event) => update('imprint', event.target.value)}
                      placeholder="PENGUIN CLASSICS"
                      className="field-input"
                    />
                  </label>
                )}
                <label className="block">
                  <span className="field-label">
                    {design.template === 'image' ? 'Sottotitolo' : 'Serie / fandom'}
                  </span>
                  <input
                    value={design.series}
                    maxLength={200}
                    onChange={(event) => update('series', event.target.value)}
                    placeholder={
                      design.template === 'image' ? 'Sottotitolo o raccolta' : 'Serie, fandom o raccolta'
                    }
                    className="field-input"
                  />
                </label>
              </EditorSection>

              <EditorSection title="Impaginazione">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {TEMPLATES.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => update('template', template.id)}
                      className={cn(
                        'rounded-xl border p-2 text-left transition',
                        design.template === template.id
                          ? 'border-accent-500/60 bg-accent-500/10'
                          : 'border-black/[0.07] bg-ink-800 hover:border-black/15 hover:bg-black/[0.04]',
                      )}
                    >
                      <TemplateSwatch
                        template={template.id}
                        paper={design.paper}
                        accent={design.accent}
                        imageDataUrl={design.imageDataUrl}
                      />
                      <span className="mt-2 block text-[11px] font-semibold text-ink-200">
                        {template.label}
                      </span>
                    </button>
                  ))}
                </div>
              </EditorSection>

              {design.template === 'image' && (
                <EditorSection
                  title="Immagine"
                  hint="Carica una foto dal computer: riempirà il riquadro superiore con ritaglio automatico."
                >
                  <div
                    className="flex items-start gap-3 rounded-xl border border-black/[0.07] bg-ink-800 p-3"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const file = event.dataTransfer.files?.[0];
                      if (file) void loadCoverImage(file);
                    }}
                  >
                    <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-ink-800 text-ink-500 ring-1 ring-black/[0.08]">
                      {design.imageDataUrl ? (
                        <img
                          src={design.imageDataUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <IconImage className="h-6 w-6" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-[12px] font-semibold text-ink-200"
                        title={design.imageName || undefined}
                      >
                        {design.imageName || 'Nessuna immagine caricata'}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
                        JPG, PNG o WebP. Puoi anche trascinare il file qui.
                      </p>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => imageInputRef.current?.click()}
                          disabled={imageBusy}
                          className="btn-ghost px-2.5 py-1.5 text-[11px]"
                        >
                          <IconUpload className="h-3.5 w-3.5" />
                          {imageBusy
                            ? 'Carico…'
                            : design.imageDataUrl
                              ? 'Sostituisci'
                              : 'Carica immagine'}
                        </button>
                        {design.imageDataUrl && (
                          <button
                            type="button"
                            onClick={() =>
                              setDesign((current) => ({
                                ...current,
                                imageDataUrl: null,
                                imageName: '',
                              }))
                            }
                            disabled={imageBusy}
                            className="btn-subtle px-2.5 py-1.5 text-[11px] text-rose-600 hover:bg-rose-500/10 hover:text-rose-700"
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                            Rimuovi
                          </button>
                        )}
                      </div>
                      <input
                        ref={imageInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (file) void loadCoverImage(file);
                        }}
                      />
                    </div>
                  </div>
                </EditorSection>
              )}

              <EditorSection title="Palette">
                <div className="grid grid-cols-2 gap-2">
                  {PALETTES.map((palette) => (
                    <button
                      key={palette.id}
                      type="button"
                      onClick={() => applyPalette(palette.id)}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-2 py-2 text-left transition',
                        design.paletteId === palette.id
                          ? 'border-accent-500/60 bg-accent-500/10'
                          : 'border-black/[0.07] bg-ink-800 hover:border-black/15 hover:bg-black/[0.04]',
                      )}
                    >
                      <span
                        className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full ring-1 ring-black/25"
                        style={{ backgroundColor: palette.paper }}
                      >
                        <span
                          className="absolute inset-y-0 right-0 w-[42%]"
                          style={{ backgroundColor: palette.accent }}
                        />
                      </span>
                      <span className="text-[11px] leading-tight text-ink-200">{palette.label}</span>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <ColorField
                    label="Sfondo"
                    value={design.paper}
                    onChange={(value) =>
                      setDesign((current) => ({
                        ...current,
                        paletteId: 'custom',
                        paper: value,
                      }))
                    }
                  />
                  <ColorField
                    label="Accento"
                    value={design.accent}
                    onChange={(value) =>
                      setDesign((current) => ({
                        ...current,
                        paletteId: 'custom',
                        accent: value,
                      }))
                    }
                  />
                </div>
              </EditorSection>

              <EditorSection title="Dettagli">
                <label className="block">
                  <span className="field-label">Carattere</span>
                  <select
                    value={design.typeface}
                    onChange={(event) => update('typeface', event.target.value as Typeface)}
                    className="field-input"
                  >
                    {Object.entries(TYPEFACES).map(([key, typeface]) => (
                      <option key={key} value={key}>
                        {typeface.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <span className="field-label">Marchio</span>
                  <div className="grid grid-cols-2 gap-2">
                    {LOGOS.map((logo) => (
                      <button
                        key={logo.id}
                        type="button"
                        onClick={() => update('logo', logo.id)}
                        className={cn(
                          'rounded-lg border px-2.5 py-2 text-left text-[11px] font-medium transition',
                          design.logo === logo.id
                            ? 'border-accent-500/60 bg-accent-500/10 text-accent-700'
                            : 'border-black/[0.07] bg-ink-800 text-ink-300 hover:border-black/15 hover:bg-black/[0.04]',
                        )}
                      >
                        {logo.label}
                      </button>
                    ))}
                  </div>
                </div>
              </EditorSection>
            </div>
          </aside>
        </div>

        <footer className="flex flex-col gap-3 border-t border-black/[0.06] bg-white/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Formato
            </span>
            <div className="flex rounded-lg border border-black/[0.07] bg-ink-800 p-0.5">
              {(['jpeg', 'png'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => update('format', format)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition',
                    design.format === format
                      ? 'bg-accent-600 text-white'
                      : 'text-ink-500 hover:text-ink-200',
                  )}
                >
                  {format === 'jpeg' ? 'JPG' : 'PNG'}
                </button>
              ))}
            </div>
            <span className="hidden text-[11px] text-ink-500 lg:inline">
              {EXPORT_WIDTH} × {EXPORT_HEIGHT} px
            </span>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={download}
              disabled={busy !== null || imageBusy}
              className="btn-ghost flex-1 sm:flex-none"
            >
              <IconDownload className="h-4 w-4" />
              {busy === 'download' ? 'Genero…' : 'Scarica'}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy !== null || imageBusy}
              className="btn-primary flex-1 sm:flex-none"
            >
              <IconSparkle className="h-4 w-4" />
              {busy === 'save' ? 'Salvo…' : 'Salva come copertina'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------ sotto-viste -- */

function EditorSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-black/[0.06] pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">{title}</h3>
        {hint && <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{hint}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function TemplateSwatch({
  template,
  paper,
  accent,
  imageDataUrl,
}: {
  template: Template;
  paper: string;
  accent: string;
  imageDataUrl?: string | null;
}) {
  return (
    <span
      className="relative block h-16 w-full overflow-hidden rounded-md ring-1 ring-black/20"
      style={{ backgroundColor: paper }}
    >
      {template === 'bands' && (
        <>
          <span className="absolute inset-x-0 top-0 h-[23%]" style={{ backgroundColor: accent }} />
          <span className="absolute inset-x-0 bottom-0 h-[23%]" style={{ backgroundColor: accent }} />
          <span
            className="absolute left-1/2 top-[45%] h-0.5 w-6 -translate-x-1/2 rounded-full opacity-70"
            style={{ backgroundColor: accent }}
          />
          <span
            className="absolute left-1/2 top-[55%] h-0.5 w-4 -translate-x-1/2 rounded-full opacity-40"
            style={{ backgroundColor: accent }}
          />
        </>
      )}
      {template === 'frame' && (
        <>
          <span
            className="absolute inset-1.5 rounded-[3px] border"
            style={{ borderColor: accent }}
          />
          <span
            className="absolute left-1/2 top-[38%] h-0.5 w-6 -translate-x-1/2 rounded-full opacity-70"
            style={{ backgroundColor: accent }}
          />
          <span
            className="absolute inset-x-2 bottom-2 h-[22%] rounded-[2px]"
            style={{ backgroundColor: accent }}
          />
        </>
      )}
      {template === 'block' && (
        <>
          <span className="absolute inset-x-0 top-0 h-[67%]" style={{ backgroundColor: accent }} />
          <span
            className="absolute left-1/2 top-[50%] h-0.5 w-6 -translate-x-1/2 rounded-full opacity-70"
            style={{ backgroundColor: paper }}
          />
          <span
            className="absolute left-1/2 top-[30%] h-0.5 w-5 -translate-x-1/2 rounded-full opacity-50"
            style={{ backgroundColor: paper }}
          />
        </>
      )}
      {template === 'image' && (
        <>
          {imageDataUrl ? (
            <img
              src={imageDataUrl}
              alt=""
              draggable={false}
              className="absolute inset-x-0 top-0 h-[69.3%] w-full object-cover"
            />
          ) : (
            <span
              className="absolute inset-x-0 top-0 h-[69.3%]"
              style={{ backgroundColor: accent }}
            />
          )}
          <span
            className="absolute inset-x-0 top-[69.3%] h-[4.9%]"
            style={{ backgroundColor: '#FFFFFF' }}
          />
          <span
            className="absolute inset-x-0 bottom-0 top-[74.2%]"
            style={{ backgroundColor: '#0D0C0B' }}
          />
          <span
            className="absolute left-1/2 top-[71.75%] h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ backgroundColor: accent }}
          />
          <span
            className="absolute inset-x-[24%] top-[82.6%] h-0.5 rounded-full"
            style={{ backgroundColor: accent, opacity: 0.9 }}
          />
          <span
            className="absolute inset-x-[31%] top-[88.4%] h-0.5 rounded-full"
            style={{ backgroundColor: '#F8F3E9', opacity: 0.8 }}
          />
          <span
            className="absolute inset-x-[36%] top-[92.2%] h-0.5 rounded-full"
            style={{ backgroundColor: '#F8F3E9', opacity: 0.45 }}
          />
        </>
      )}
    </span>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-black/[0.07] bg-ink-800 p-1.5 transition hover:border-black/15">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-8 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-500">
          {label}
        </span>
        <span className="block truncate font-mono text-[10px] text-ink-300">
          {value.toUpperCase()}
        </span>
      </span>
    </label>
  );
}
