// Compila main e preload con esbuild. Il codice di ../server/src (lettura e scrittura
// di Apple Books, riscrittura dell'OPF) entra nel bundle di main; adm-zip e
// fast-xml-parser sono JS puro e finiscono nel bundle, @napi-rs/canvas e' nativo
// e resta esterno (installato in node_modules e impacchettato da electron-builder).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

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

for (const file of ['setup.html', 'setup.js']) copyFileSync(`src/${file}`, `dist/${file}`);
