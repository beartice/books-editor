// electron-builder lascia fuori ogni cartella node_modules da extraResources: quelle del server
// (@napi-rs/canvas con il suo binario, pdfjs-dist) si copiano qui, prima della firma.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const resources =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const source = path.join(__dirname, 'server-dist', 'node_modules');
  if (!fs.existsSync(source)) throw new Error('server-dist/node_modules mancante: esegui prima `node build.mjs`');
  fs.cpSync(source, path.join(resources, 'server', 'node_modules'), { recursive: true });
};
