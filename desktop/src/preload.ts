import { contextBridge, ipcRenderer } from 'electron';

// Ponte `window.booksDesktop`: solo questi metodi. Gli argomenti li valida il main,
// che controlla anche l'origine della pagina chiamante.
contextBridge.exposeInMainWorld('booksDesktop', {
  // Apple Books esiste solo sul Mac: su Windows l'interfaccia ne nasconde le funzioni.
  appleBooks: process.platform === 'darwin',
  pickFolder: () => ipcRenderer.invoke('books:pick-folder'),
  info: () => ipcRenderer.invoke('books:info'),
  appleBooksRead: () => ipcRenderer.invoke('books:apple-read'),
  appleBooksStatus: (meta: unknown) => ipcRenderer.invoke('books:apple-status', meta),
  appleBooksWrite: (args: unknown) => ipcRenderer.invoke('books:apple-write', args),
  openInBooks: (args: unknown) => ipcRenderer.invoke('books:open-in-books', args),
});
