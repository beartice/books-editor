/**
 * Genera EPUB di esempio per provare l'estrazione dei metadati.
 *   node scripts/make-samples.mjs [destinazione]
 */
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const outDir = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'library'));

/* ---------------------------------------------- generatore di copertine PNG -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Copertina di prova: gradiente verticale. */
function makeCover(width, height, top, bottom) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * stride;
    raw[offset] = 0; // filtro "none"
    const t = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const i = offset + 1 + x * 3;
      raw[i] = Math.round(top[0] + (bottom[0] - top[0]) * t);
      raw[i + 1] = Math.round(top[1] + (bottom[1] - top[1]) * t);
      raw[i + 2] = Math.round(top[2] + (bottom[2] - top[2]) * t);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function xhtml(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="it">
<head><title>pagina</title></head>
<body>
${body}
</body>
</html>`;
}

function buildEpub({ opf, files, cover }) {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(`OEBPS/${name}`, Buffer.from(content, 'utf8'));
  }
  if (cover) zip.addFile('OEBPS/cover.png', cover);
  return zip.toBuffer();
}

/* ------------------------------------------------------------------ libro -- */

const bookOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Il Giardino Segreto</dc:title>
    <dc:creator opf:role="aut">Maria Bianchi</dc:creator>
    <dc:creator opf:role="trl">Luigi Rossi</dc:creator>
    <dc:language>it</dc:language>
    <dc:publisher>Editions Aurora</dc:publisher>
    <dc:date>2019-04-12</dc:date>
    <dc:identifier opf:scheme="ISBN">978-88-0000-111-2</dc:identifier>
    <dc:identifier id="pub-id">urn:uuid:2b1c9d3e-1111-2222-3333-444455556666</dc:identifier>
    <dc:description>Un romanzo sobre i giardini che non esistono, e le persone che li cercano.</dc:description>
    <dc:subject>Fantasy</dc:subject>
    <dc:subject>Giardini</dc:subject>
    <meta name="calibre:series" content="I Custodi delle Stagioni"/>
    <meta name="calibre:series_index" content="2"/>
  </metadata>
  <manifest>
    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const LOREM_1 =
  'Il vento attraversava il giardino in silenzio, portando con se odore di terra bagnata e foglie. ';
const LOREM_2 =
  'Le ragazze scendevano per le scale di pietra, contando i gradini come un rito. ';
const LOREM_3 =
  'La notte era lenta e profonda, e i gatti attraversavano i tetti con agilita di piccoli fantasmi. ';

const bookEpub = buildEpub({
  opf: bookOpf,
  cover: makeCover(300, 450, [92, 64, 168], [26, 32, 56]),
  files: {
    'chapter1.xhtml': xhtml(`<h1>Capitolo 1</h1><p>${LOREM_1.repeat(40)}</p>`),
    'chapter2.xhtml': xhtml(`<h1>Capitolo 2</h1><p>${LOREM_2.repeat(40)}</p>`),
  },
});

/* ----------------------------------------------------------------- fanfic -- */

const fanficInfo = `Title: La notte dei cento gatti
Author: Elena Ferri
Fandom: Arithverse
Characters: Arith, Lume, Sabbia
Relationship: Arith/Lume
Rating: Teen and Up Audiences
Warnings: No Archive Warnings, Minor Character Death
Language: English
Words: 42317
Chapters: 12
Status: Work in Progress
Summary: Una storia notturna fra un mercante di stelle e la ragazza che ruba i sogni.
Series: Cronache di Arith
Beta: Giulia
Additional Tags: Slow Burn, Found Family`;

const fanficOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>La notte dei cento gatti</dc:title>
    <dc:creator opf:role="aut">Elena Ferri</dc:creator>
    <dc:language>en</dc:language>
    <dc:description>Una storia notturna fra un mercante di stelle e la ragazza che ruba i sogni.</dc:description>
    <dc:subject>Arithverse</dc:subject>
    <dc:subject>Slow Burn</dc:subject>
    <dc:identifier id="BookId">o3:12345678</dc:identifier>
  </metadata>
  <manifest>
    <item id="info" href="info.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="info"/>
    <itemref idref="c1"/>
  </spine>
</package>`;

const fanficEpub = buildEpub({
  opf: fanficOpf,
  files: {
    'info.xhtml': xhtml(
      fanficInfo
        .split('\n')
        .map((line) => `<p>${line}</p>`)
        .join('\n'),
    ),
    'chapter1.xhtml': xhtml(`<p>${LOREM_3.repeat(60)}</p>`),
  },
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'Il Giardino Segreto.epub'), bookEpub);
fs.writeFileSync(path.join(outDir, 'La notte dei cento gatti.epub'), fanficEpub);

console.log(`Creati 2 epub di esempio in ${outDir}`);
