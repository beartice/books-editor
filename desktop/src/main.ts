import { BrowserWindow, Menu, app, ipcMain, net, session, shell } from 'electron';
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
import { normalizeServerUrl, readServerUrl, sameOrigin, writeServerUrl } from './common';

// Solo per le prove: cartella dei dati dell'app indicata dall'ambiente.
if (process.env.BOOKS_DESKTOP_USER_DATA) app.setPath('userData', process.env.BOOKS_DESKTOP_USER_DATA);

const PARTITION = 'persist:books';
const SETUP_FILE = path.join(__dirname, 'setup.html');
const SETUP_URL = pathToFileURL(SETUP_FILE).href;

let serverUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;

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
  ipcMain.handle('books:info', guarded(() => ({ ok: true, value: { version: app.getVersion(), appleBooks: true } })));
  ipcMain.handle('books:apple-read', guarded(() => readApple()));
  ipcMain.handle('books:apple-status', guarded((meta) => statusApple(meta)));
  ipcMain.handle('books:apple-write', guarded((args) => writeApple(args)));
  ipcMain.handle('books:open-in-books', guarded((args) => openInBooks(args)));

  // Pagina di configurazione: solo il file locale setup.html.
  const fromSetup = (event: IpcMainInvokeEvent): boolean =>
    event.senderFrame === event.sender.mainFrame && event.senderFrame?.url.split('?')[0] === SETUP_URL;
  ipcMain.handle('setup:current', (event) => (fromSetup(event) ? (serverUrl ?? '') : ''));
  ipcMain.handle('setup:cancel', (event) => {
    if (fromSetup(event)) setupWindow?.close();
  });
  ipcMain.handle('setup:connect', async (event, input: unknown) => {
    if (!fromSetup(event)) return { ok: false, message: 'Richiesta rifiutata' };
    const url = normalizeServerUrl(String(input ?? ''));
    if (!url) return { ok: false, message: 'Indirizzo non valido: usa un indirizzo che inizia con http:// o https://' };
    const problem = await checkServer(url);
    if (problem) return { ok: false, message: problem };
    writeServerUrl(url);
    serverUrl = url;
    setupWindow?.close();
    openMainWindow();
    return { ok: true, message: '' };
  });
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
    width: 520,
    height: 400,
    title: 'Books Editor',
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: webPreferences('setupPreload.js'),
  });
  setupWindow = window;
  window.on('closed', () => {
    setupWindow = null;
    // Chiusa la configurazione senza un server non resta nulla da mostrare.
    if (!mainWindow && !serverUrl) app.quit();
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void window.loadFile(SETUP_FILE, message ? { query: { msg: message } } : undefined);
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
    openSetupWindow(`Impossibile aprire ${origin}: ${description}`);
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
        { label: 'Cambia server…', click: () => openSetupWindow() },
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
    const window = mainWindow ?? setupWindow;
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
    serverUrl = readServerUrl();
    if (serverUrl) openMainWindow();
    else openSetupWindow();

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) {
        if (serverUrl) openMainWindow();
        else openSetupWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
