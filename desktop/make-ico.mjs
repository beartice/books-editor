// Genera build/icon.ico (Windows) da build/icon.png: un PNG per ciascuna dimensione.
//   node make-ico.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync, writeFileSync } from 'node:fs';

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const source = await loadImage(readFileSync('build/icon.png'));

const images = SIZES.map((size) => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, size, size);
  return { size, data: canvas.toBuffer('image/png') };
});

// ICONDIR (6 byte) + una ICONDIRENTRY (16 byte) per immagine + i PNG.
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); // riservato
header.writeUInt16LE(1, 2); // tipo: icona
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, data }, index) => {
  const entry = 6 + 16 * index;
  header.writeUInt8(size === 256 ? 0 : size, entry); // larghezza (0 = 256)
  header.writeUInt8(size === 256 ? 0 : size, entry + 1); // altezza
  header.writeUInt8(0, entry + 2); // colori in tavolozza
  header.writeUInt8(0, entry + 3); // riservato
  header.writeUInt16LE(1, entry + 4); // piani colore
  header.writeUInt16LE(32, entry + 6); // bit per pixel
  header.writeUInt32LE(data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += data.length;
});
writeFileSync('build/icon.ico', Buffer.concat([header, ...images.map((image) => image.data)]));
console.log(`build/icon.ico: ${SIZES.join(', ')} px`);
