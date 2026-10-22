import { contextBridge, ipcRenderer } from 'electron';

// Ponte `window.booksDesktop`: solo questi metodi. Gli argomenti li valida il main,
// che controlla anche l'origine della pagina chiamante.
contextBridge.exposeInMainWorld('booksDesktop', {
  info: () => ipcRenderer.invoke('books:info'),
  appleBooksRead: () => ipcRenderer.invoke('books:apple-read'),
  appleBooksStatus: (meta: unknown) => ipcRenderer.invoke('books:apple-status', meta),
  appleBooksWrite: (args: unknown) => ipcRenderer.invoke('books:apple-write', args),
  openInBooks: (args: unknown) => ipcRenderer.invoke('books:open-in-books', args),
});
