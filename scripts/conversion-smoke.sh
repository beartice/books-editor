#!/usr/bin/env bash
# Prova della conversione di formato dentro l'immagine Docker (senza rete).
#
# Crea file di prova (EPUB, MOBI, AZW3, FB2, DJVU con e senza testo) con gli
# strumenti dell'immagine e li passa al codice dell'app (server/dist/.../convert.js).
# Stampa una tabella e termina con codice diverso da 0 se qualcosa fallisce.
# Uno strumento mancante fa saltare le prove che ne dipendono (SKIP).
#
# Uso, dall'immagine gia' costruita (nessun volume della libreria):
#   docker run --rm --read-only --tmpfs /tmp:size=1g -v "$PWD/scripts:/scripts:ro" \
#     books-editor:latest bash /scripts/conversion-smoke.sh
#
# APP_DIR: cartella dell'app (default /app, dove sta server/dist).

set -u

APP_DIR="${APP_DIR:-/app}"
CONVERT_JS="$APP_DIR/server/dist/server/src/convert.js"
[ -f "$CONVERT_JS" ] || { echo "Manca $CONVERT_JS: serve 'npm run build'" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
export CALIBRE_CONFIG_DIRECTORY="$WORK/calibre-config"
export CALIBRE_CACHE_DIRECTORY="$WORK/calibre-cache"
export CALIBRE_TEMP_DIR="$WORK/tmp"
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-offscreen}"
mkdir -p "$HOME" "$CALIBRE_TEMP_DIR" "$WORK/in"
IN="$WORK/in"
CASES="$WORK/cases.tsv"
: > "$CASES"

have() { command -v "$1" >/dev/null 2>&1; }
# name <TAB> file <TAB> formato atteso <TAB> testo atteso (EPUB), oppure SKIP e motivo
add_case() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$CASES"; }
skip_case() { printf '%s\tSKIP\t%s\t\n' "$1" "$2" >> "$CASES"; }

TITLE="Libro di Prova Smoke"
BODY="Questo e' il testo di prova del libro. Contiene abbastanza parole per superare la soglia con cui un DJVU viene considerato una scansione senza testo. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris."

# --- EPUB di partenza, poi MOBI e AZW3 ---------------------------------------
if have ebook-convert; then
  cat > "$IN/base.html" <<EOF
<html><head><meta charset="utf-8"><title>$TITLE</title></head>
<body><h1>$TITLE</h1><p>$BODY</p></body></html>
EOF
  if ebook-convert "$IN/base.html" "$IN/base.epub" --title "$TITLE" --authors "Autore Prova" >"$WORK/mk-epub.log" 2>&1; then
    for ext in mobi azw3; do
      if ebook-convert "$IN/base.epub" "$IN/prova.$ext" >"$WORK/mk-$ext.log" 2>&1; then
        add_case "$ext" "$IN/prova.$ext" epub "Libro di Prova"
      else
        add_case "$ext" "$IN/MANCANTE.$ext" epub "Libro di Prova"
        echo "Creazione di prova.$ext non riuscita:"; tail -n 5 "$WORK/mk-$ext.log"
      fi
    done
  else
    echo "Creazione dell'EPUB di base non riuscita:"; tail -n 5 "$WORK/mk-epub.log"
    skip_case mobi "impossibile creare l'EPUB di base"
    skip_case azw3 "impossibile creare l'EPUB di base"
  fi
else
  skip_case mobi "ebook-convert assente"
  skip_case azw3 "ebook-convert assente"
fi

# --- FB2 scritto a mano -------------------------------------------------------
cat > "$IN/prova.fb2" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <genre>prose</genre>
      <author><first-name>Autore</first-name><last-name>Prova</last-name></author>
      <book-title>$TITLE</book-title>
      <lang>it</lang>
    </title-info>
    <document-info><author><nickname>test</nickname></author><date>2024-01-01</date><id>smoke-fb2</id><version>1.0</version></document-info>
  </description>
  <body><section><title><p>Capitolo 1</p></title><p>$BODY</p></section></body>
</FictionBook>
EOF
if have ebook-convert; then
  add_case fb2 "$IN/prova.fb2" epub "Libro di Prova"
else
  skip_case fb2 "ebook-convert assente"
fi

# --- DJVU senza testo (solo immagine) e con testo ------------------------------
if have cjb2 && have djvused; then
  # Bitmap PBM 64x64 (P1) con un quadrato nero al centro.
  {
    echo "P1"; echo "64 64"
    for y in $(seq 0 63); do
      row=""
      for x in $(seq 0 63); do
        if [ "$x" -ge 16 ] && [ "$x" -lt 48 ] && [ "$y" -ge 16 ] && [ "$y" -lt 48 ]; then row="${row}1 "; else row="${row}0 "; fi
      done
      echo "$row"
    done
  } > "$IN/pagina.pbm"
  if cjb2 "$IN/pagina.pbm" "$IN/scan.djvu" >"$WORK/mk-djvu.log" 2>&1; then
    if have ddjvu; then add_case djvu-scansione "$IN/scan.djvu" pdf ""; else skip_case djvu-scansione "ddjvu assente"; fi
    cp "$IN/scan.djvu" "$IN/testo.djvu"
    printf '(page 0 0 64 64 "%s")\n' "$BODY" > "$IN/testo.txt"
    if djvused "$IN/testo.djvu" -e "select 1; set-txt $IN/testo.txt" -s >"$WORK/mk-txt.log" 2>&1; then
      if have ebook-convert && have djvutxt; then
        # Calibre estrae il testo con djvutxt: il titolo non c'e', si cerca una frase del corpo.
        add_case djvu-testo "$IN/testo.djvu" epub "testo di prova del libro"
      else
        skip_case djvu-testo "ebook-convert o djvutxt assente"
      fi
    else
      echo "Aggiunta del livello di testo non riuscita:"; tail -n 5 "$WORK/mk-txt.log"
      skip_case djvu-testo "djvused non ha scritto il testo"
    fi
  else
    echo "Creazione del DJVU non riuscita:"; tail -n 5 "$WORK/mk-djvu.log"
    skip_case djvu-scansione "cjb2 non ha creato il DJVU"
    skip_case djvu-testo "cjb2 non ha creato il DJVU"
  fi
else
  skip_case djvu-scansione "cjb2 o djvused assenti"
  skip_case djvu-testo "cjb2 o djvused assenti"
fi

# --- conversione tramite il codice dell'app --------------------------------------
cat > "$WORK/run.mjs" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [convertJs, appDir, casesFile, work] = process.argv.slice(2);
const require = createRequire(path.join(appDir, 'package.json'));
const AdmZip = require('adm-zip');
const { convertToReadable, conversionSupport } = await import(pathToFileURL(convertJs).href);

console.log('Supporto rilevato:', JSON.stringify(conversionSupport()));

const rows = [];
let failures = 0;
for (const line of fs.readFileSync(casesFile, 'utf8').split('\n').filter(Boolean)) {
  const [name, file, expected, text] = line.split('\t');
  if (file === 'SKIP') {
    rows.push([name, 'SKIP', '-', '-', '-', expected]);
    continue;
  }
  const workDir = fs.mkdtempSync(path.join(work, 'conv-'));
  try {
    const started = Date.now();
    const result = await convertToReadable(file, workDir);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const head = Buffer.alloc(5);
    const fd = fs.openSync(result.outputPath, 'r');
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    const size = fs.statSync(result.outputPath).size;
    const signature = result.format === 'epub' ? head.subarray(0, 2).toString() === 'PK' : head.toString() === '%PDF-';
    let content = 'n/a';
    if (result.format === 'epub' && text) {
      const zip = new AdmZip(result.outputPath);
      const all = zip.getEntries().filter((e) => /\.(x?html?|opf|ncx)$/i.test(e.entryName)).map((e) => e.getData().toString('utf8')).join('\n');
      content = all.includes(text) ? 'ok' : 'MANCA';
    }
    const ok = result.format === expected && signature && size > 0 && content !== 'MANCA';
    if (!ok) failures += 1;
    rows.push([name, ok ? 'OK' : 'FAIL', `${result.format} (atteso ${expected})`, `${size} B`, `firma ${signature ? 'ok' : 'errata'}, testo ${content}`, `${result.method}, ${seconds}s`]);
  } catch (error) {
    failures += 1;
    rows.push([name, 'FAIL', '-', '-', '-', error.message]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const header = ['caso', 'esito', 'formato', 'dimensione', 'controlli', 'note'];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const fmt = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ');
console.log(fmt(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(fmt(r));
console.log(failures ? `\n${failures} prove fallite` : '\nTutte le prove eseguite sono riuscite');
process.exit(failures ? 1 : 0);
EOF

node "$WORK/run.mjs" "$CONVERT_JS" "$APP_DIR" "$CASES" "$WORK"
