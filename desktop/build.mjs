// Compila l'app e prepara il server da impacchettare.
//
//   node build.mjs                      per il computer su cui gira (sviluppo)
//   node build.mjs --target=win32-x64   per un altro sistema: darwin-arm64, darwin-x64, win32-x64
//
// 1. main e preload con esbuild. Il codice di ../server/src (lettura e scrittura di Apple Books,
//    riscrittura dell'OPF) entra nel bundle di main; adm-zip e fast-xml-parser sono JS puro.
// 2. Il server (../server/src/index.ts) diventa un unico file in server-dist/server.mjs, con
//    il front-end (../web/dist) e le sole dipendenze native: @napi-rs/canvas con il binario
//    del sistema di destinazione e pdfjs-dist. electron-builder copia server-dist in Resources/server,
//    fuori da app.asar: il server legge i file dal disco e i moduli nativi non vanno nell'archivio.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const targetArg = process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length);
const target = targetArg ?? `${process.platform}-${process.arch}`;
// Pacchetto con il binario di @napi-rs/canvas per ciascun sistema di destinazione.
const CANVAS_BINARIES = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'win32-x64': 'win32-x64-msvc',
};
const binary = CANVAS_BINARIES[target];
if (!binary) {
  console.error(`Sistema non supportato: ${target} (ammessi: ${Object.keys(CANVAS_BINARIES).join(', ')})`);
  process.exit(1);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // Se la radice del progetto non e' installata, le dipendenze si cercano qui.
  nodePaths: ['node_modules'],
};

await build({
  ...common,
  entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts', setupPreload: 'src/setupPreload.ts' },
  outdir: 'dist',
  external: ['electron', '@napi-rs/canvas'],
});

for (const file of ['setup.html', 'setup.js', 'status.html', 'status.js']) copyFileSync(`src/${file}`, `dist/${file}`);

/* ----------------------------------------------------------------- server -- */

const webDist = path.resolve('..', 'web', 'dist');
if (!existsSync(path.join(webDist, 'index.html'))) {
  console.error('Manca ../web/dist: esegui prima `npm run build` nella radice del progetto.');
  process.exit(1);
}

const out = 'server-dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  bundle: true,
  platform: 'node',
  format: 'esm', // il server usa il top-level await
  target: 'node22',
  logLevel: 'info',
  entryPoints: [path.resolve('..', 'server', 'src', 'index.ts')],
  outfile: path.join(out, 'server.mjs'),
  // Le dipendenze CommonJS del bundle chiamano require(): in ESM va ricreato.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // Nativi e pdf.js (che carica da disco il proprio worker) restano moduli veri in server-dist/node_modules.
  external: ['@napi-rs/canvas', 'pdfjs-dist'],
});

// Punto d'ingresso (CommonJS): carica il bundle ESM ed esce se l'app che l'ha avviato sparisce.
writeFileSync(
  path.join(out, 'launcher.cjs'),
  [
    "process.on('disconnect', () => process.exit(0));",
    "import('./server.mjs').catch((error) => {",
    '  console.error(error);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n'),
);

cpSync(webDist, path.join(out, 'web'), { recursive: true });

const modules = path.join(out, 'node_modules');
mkdirSync(path.join(modules, '@napi-rs'), { recursive: true });

const rootModules = path.resolve('..', 'node_modules');
const canvasDir = path.join(rootModules, '@napi-rs', 'canvas');
cpSync(canvasDir, path.join(modules, '@napi-rs', 'canvas'), { recursive: true });

// pdf.js: solo la versione "legacy" per Node (senza mappe dei sorgenti).
const pdfjs = path.join(rootModules, 'pdfjs-dist');
mkdirSync(path.join(modules, 'pdfjs-dist', 'legacy', 'build'), { recursive: true });
for (const file of ['package.json', 'LICENSE']) copyFileSync(path.join(pdfjs, file), path.join(modules, 'pdfjs-dist', file));
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
  copyFileSync(path.join(pdfjs, 'legacy', 'build', file), path.join(modules, 'pdfjs-dist', 'legacy', 'build', file));
}

// Binario di @napi-rs/canvas per il sistema di destinazione: si scarica il pacchetto npm
// (versione identica a quella di @napi-rs/canvas) senza toccare le dipendenze del progetto.
const canvasVersion = JSON.parse(readFileSync(path.join(canvasDir, 'package.json'), 'utf8')).version;
const packageName = `@napi-rs/canvas-${binary}`;
const cacheDir = path.resolve('.cache', 'native', `${binary}-${canvasVersion}`);
if (!existsSync(path.join(cacheDir, 'package', 'package.json'))) {
  mkdirSync(cacheDir, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = execFileSync(npm, ['pack', `${packageName}@${canvasVersion}`, '--silent', '--pack-destination', cacheDir], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
    .trim()
    .split('\n')
    .pop();
  // Percorsi relativi alla cartella: il tar di Git per Windows legge «D:\...»
  // come «host D, file remoto» e fallisce («Cannot connect to D: resolve failed»).
  execFileSync('tar', ['-xzf', packed.trim()], { cwd: cacheDir });
}
cpSync(path.join(cacheDir, 'package'), path.join(modules, '@napi-rs', `canvas-${binary}`), { recursive: true });

console.log(`Server pronto in ${out} per ${target} (canvas ${canvasVersion})`);
