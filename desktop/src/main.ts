import { BrowserWindow, Menu, app, dialog, ipcMain, net, session, shell } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  cleanOpenDir,
  openInBooks,
  readApple,
  statusApple,
  writeApple,
} from './bridge';
import { normalizeServerUrl, readConfig, sameOrigin, updateConfig } from './common';
import type { Mode } from './common';
import { lastServerLog, startLocalServer, stopLocalServer } from './localServer';
import fs from 'node:fs';

// Solo per le prove: cartella dei dati dell'app indicata dall'ambiente.
if (process.env.BOOKS_DESKTOP_USER_DATA) app.setPath('userData', process.env.BOOKS_DESKTOP_USER_DATA);

const PARTITION = 'persist:books';
const SETUP_FILE = path.join(__dirname, 'setup.html');
const SETUP_URL = pathToFileURL(SETUP_FILE).href;
const STATUS_FILE = path.join(__dirname, 'status.html');
const STATUS_URL = pathToFileURL(STATUS_FILE).href;

// Nel pacchetto il server (e il suo @napi-rs/canvas, usato anche dal ponte) sta in Resources/server.
if (app.isPackaged) {
  const serverModules = path.join(process.resourcesPath, 'server', 'node_modules');
  process.env.NODE_PATH = [serverModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  // Rilegge NODE_PATH: l'API non e' pubblica, ma e' quella che usano da sempre gli strumenti per i percorsi dei moduli.
  (require('node:module') as unknown as { _initPaths(): void })._initPaths();
}

/** Origine mostrata nella finestra: l'indirizzo del server remoto, o quello del server locale. */
let serverUrl: string | null = null;
let mode: Mode | null = null;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let statusWindow: BrowserWindow | null = null;
let quitting = false;

/** L'app main lavora solo su dati locali; ogni chiamata deve arrivare dal frame principale del server configurato. */
function trusted(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  return sameOrigin(frame.url, serverUrl);
}

function guarded<T>(handler: (...args: any[]) => Promise<T> | T) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!trusted(event)) {
      return { ok: false, code: 'failed', message: 'Richiesta rifiutata: origine non autorizzata' };
    }
    return handler(...args);
  };
}

function registerIpc(): void {
  ipcMain.handle(
    'books:info',
    guarded(() => ({
      ok: true,
      value: { version: app.getVersion(), appleBooks: process.platform === 'darwin', localServer: mode === 'local' },
    })),
  );
  // Scelta della cartella della libreria dalle Impostazioni (solo con il server dentro l'app).
  ipcMain.handle(
    'books:pick-folder',
    guarded(async () => {
      if (mode !== 'local') return { ok: false, code: 'failed', message: 'Disponibile solo con il server su questo computer' };
      return { ok: true, value: { path: await pickFolder(mainWindow) } };
    }),
  );
  ipcMain.handle('books:apple-read', guarded(() => readApple()));
  ipcMain.handle('books:apple-status', guarded((meta) => statusApple(meta)));
  ipcMain.handle('books:apple-write', guarded((args) => writeApple(args)));
  ipcMain.handle('books:open-in-books', guarded((args) => openInBooks(args)));

  // Pagine locali dell'app (scelta della modalita' e stato del server): niente altre origini.
  const fromLocalPage = (event: IpcMainInvokeEvent): boolean => {
    const url = event.senderFrame?.url.split('?')[0];
    return event.senderFrame === event.sender.mainFrame && (url === SETUP_URL || url === STATUS_URL);
  };
  ipcMain.handle('setup:state', (event) => {
    if (!fromLocalPage(event)) return null;
    const config = readConfig();
    return {
      mode,
      serverUrl: config.serverUrl ?? '',
      defaultLibraryRoot: config.libraryRoot ?? defaultLibraryRoot(),
      // Si puo' annullare solo se c'e' gia' qualcosa da mostrare.
      canCancel: mode !== null,
    };
  });
  ipcMain.handle('setup:cancel', (event) => {
    if (fromLocalPage(event)) setupWindow?.close();
  });
  ipcMain.handle('setup:pick-folder', async (event, current: unknown) => {
    if (!fromLocalPage(event)) return null;
    return pickFolder(setupWindow, typeof current === 'string' ? current : undefined);
  });
  ipcMain.handle('setup:use-local', async (event, input: unknown) => {
    if (!fromLocalPage(event)) return { ok: false, message: 'Richiesta rifiutata' };
    const root = String(input ?? '').trim();
    if (!root || !path.isAbsolute(root)) return { ok: false, message: 'Indica una cartella con il percorso completo' };
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.accessSync(root, fs.constants.W_OK);
    } catch {
      return { ok: false, message: 'Non riesco a scrivere in questa cartella: sceglierne un\'altra' };
    }
    updateConfig({ mode: 'local', libraryRoot: path.resolve(root) });
    void startLocalMode();
    setupWindow?.close();
    return { ok: true, message: '' };
  });
  ipcMain.handle('setup:connect', async (event, input: unknown) => {
    if (!fromLocalPage(event)) return { ok: false, message: 'Richiesta rifiutata' };
    const url = normalizeServerUrl(String(input ?? ''));
    if (!url) return { ok: false, message: 'Indirizzo non valido: usa un indirizzo che inizia con http:// o https://' };
    const problem = await checkServer(url);
    if (problem) return { ok: false, message: problem };
    updateConfig({ mode: 'server', serverUrl: url });
    if (mode === 'local') await stopLocalServer();
    mode = 'server';
    serverUrl = url;
    openMainWindow();
    setupWindow?.close();
    closeStatus();
    return { ok: true, message: '' };
  });
  ipcMain.handle('status:restart', (event) => {
    if (fromLocalPage(event)) void startLocalMode();
  });
  ipcMain.handle('status:change-mode', (event) => {
    if (fromLocalPage(event)) openSetupWindow();
  });
}

/** Cartella proposta per la libreria al primo avvio. */
function defaultLibraryRoot(): string {
  return path.join(app.getPath('documents'), 'Books Editor');
}

/** Finestra di sistema per scegliere (o creare) una cartella; null se si annulla. */
async function pickFolder(parent: BrowserWindow | null, current?: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Cartella della libreria',
    buttonLabel: 'Scegli',
    defaultPath: current && path.isAbsolute(current) ? current : defaultLibraryRoot(),
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

/** Verifica `GET <url>/api/health` → `{ ok: true }`. Restituisce il problema, o null se va bene. */
async function checkServer(url: string): Promise<string | null> {
  try {
    const response = await net.fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return `Il server ha risposto ${response.status}: non sembra un server Books Editor`;
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (body?.ok !== true) return 'Risposta inattesa: non sembra un server Books Editor';
    return null;
  } catch (error) {
    return `Server non raggiungibile: ${(error as Error).message}`;
  }
}

function webPreferences(preload: string): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, preload),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function openExternal(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') void shell.openExternal(url);
  } catch {
    /* URL non valido: ignorato */
  }
}

function openSetupWindow(message = ''): void {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 560,
    height: 560,
    title: 'Books Editor',
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: webPreferences('setupPreload.js'),
  });
  setupWindow = window;
  window.on('closed', () => {
    setupWindow = null;
    // Chiusa la scelta senza una modalita' (o senza finestre) non resta nulla da mostrare.
    if (!mainWindow && !statusWindow && !mode) app.quit();
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void window.loadFile(SETUP_FILE, message ? { query: { msg: message } } : undefined);
}

/** Finestra con lo stato del server locale: avvio in corso oppure errore con «Riavvia». */
function showStatus(state: 'loading' | 'error', message: string): void {
  if (!statusWindow) {
    const window = new BrowserWindow({
      width: 520,
      height: 380,
      title: 'Books Editor',
      resizable: false,
      minimizable: false,
      fullscreenable: false,
      webPreferences: webPreferences('setupPreload.js'),
    });
    statusWindow = window;
    window.on('closed', () => {
      statusWindow = null;
      // Chiusa l'attesa dell'avvio senza altre finestre, si esce.
      if (!mainWindow && !setupWindow && !quitting && state === 'loading') app.quit();
    });
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  statusWindow.show();
  void statusWindow.loadFile(STATUS_FILE, { query: { state, msg: message } });
}

function closeStatus(): void {
  const window = statusWindow;
  statusWindow = null;
  window?.close();
}

/** Avvia il server dentro l'app e apre la finestra; in caso d'errore mostra lo stato con «Riavvia». */
async function startLocalMode(): Promise<void> {
  const config = readConfig();
  if (!config.libraryRoot) {
    openSetupWindow();
    return;
  }
  mode = 'local';
  serverUrl = null;
  showStatus('loading', 'Avvio di Books Editor…');
  try {
    const server = await startLocalServer(config.libraryRoot, config.localPort, (code) => {
      // Il server e' morto a app aperta.
      if (quitting) return;
      showStatus('error', `Il server di Books Editor si e' fermato (codice ${code}).\n${lastServerLog()}`.trim());
    });
    updateConfig({ localPort: server.port });
    // Il cookie dell'app va impostato prima di caricare la pagina, altrimenti la prima richiesta sarebbe respinta.
    await session.fromPartition(PARTITION).cookies.set({
      url: server.origin,
      name: 'be_desktop',
      value: server.token,
      httpOnly: true,
      sameSite: 'strict',
    });
    serverUrl = server.origin;
    openMainWindow();
    closeStatus();
  } catch (error) {
    showStatus('error', `${(error as Error).message}\n${lastServerLog()}`.trim());
  }
}

function openMainWindow(): void {
  if (!serverUrl) return;
  const origin = serverUrl;
  if (mainWindow) {
    void mainWindow.loadURL(origin);
    mainWindow.focus();
    return;
  }
  const prefs = { ...webPreferences('preload.js'), partition: PARTITION };
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 640,
    minHeight: 480,
    title: 'Books Editor',
    webPreferences: prefs,
  });
  mainWindow = window;
  window.on('closed', () => {
    mainWindow = null;
  });
  const contents = window.webContents;
  // Fuori dall'origine del server si apre il browser; qui non si naviga.
  contents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, serverUrl)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url, serverUrl)) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: prefs } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // -3 = navigazione annullata (ad esempio da una nuova richiesta).
    if (!isMainFrame || code === -3) return;
    if (mode === 'local') showStatus('error', `Impossibile aprire la libreria: ${description}`);
    else openSetupWindow(`Impossibile aprire ${origin}: ${description}`);
  });
  void window.loadURL(origin);
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Books Editor',
      submenu: [
        { role: 'about', label: 'Informazioni su Books Editor' },
        { type: 'separator' },
        { label: 'Cambia modalità…', click: () => openSetupWindow() },
        { type: 'separator' },
        { role: 'hide', label: 'Nascondi Books Editor' },
        { role: 'hideOthers', label: 'Nascondi altre' },
        { role: 'unhide', label: 'Mostra tutte' },
        { type: 'separator' },
        { role: 'quit', label: 'Esci da Books Editor' },
      ],
    },
    {
      label: 'Modifica',
      submenu: [
        { role: 'undo', label: 'Annulla' },
        { role: 'redo', label: 'Ripeti' },
        { type: 'separator' },
        { role: 'cut', label: 'Taglia' },
        { role: 'copy', label: 'Copia' },
        { role: 'paste', label: 'Incolla' },
        { role: 'selectAll', label: 'Seleziona tutto' },
      ],
    },
    {
      label: 'Vista',
      submenu: [
        { role: 'reload', label: 'Ricarica' },
        { role: 'forceReload', label: 'Ricarica ignorando la cache' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Dimensione reale' },
        { role: 'zoomIn', label: 'Ingrandisci' },
        { role: 'zoomOut', label: 'Riduci' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Schermo intero' },
      ],
    },
    {
      label: 'Finestra',
      role: 'windowMenu',
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Una sola istanza: il secondo avvio porta in primo piano la finestra.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = mainWindow ?? statusWindow ?? setupWindow;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  void app.whenReady().then(async () => {
    // Permessi del sito: niente di piu' di appunti e schermo intero.
    session.fromPartition(PARTITION).setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
    });
    registerIpc();
    buildMenu();
    void cleanOpenDir().catch(() => undefined);
    const config = readConfig();
    mode = config.mode;
    if (mode === 'local') void startLocalMode();
    else if (mode === 'server') {
      serverUrl = config.serverUrl;
      openMainWindow();
    } else openSetupWindow();

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) {
        if (serverUrl) openMainWindow();
        else if (mode !== 'local') openSetupWindow();
      }
    });
  });

  // Alla chiusura il server locale si ferma prima di uscire.
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void stopLocalServer().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
