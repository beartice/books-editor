import { contextBridge, ipcRenderer } from 'electron';

// Ponte delle sole pagine locali dell'app (scelta della modalita' e stato del server).
contextBridge.exposeInMainWorld('booksSetup', {
  state: (): Promise<{
    mode: 'local' | 'server' | null;
    serverUrl: string;
    defaultLibraryRoot: string;
    canCancel: boolean;
  } | null> => ipcRenderer.invoke('setup:state'),
  pickFolder: (current: string): Promise<string | null> => ipcRenderer.invoke('setup:pick-folder', String(current)),
  useLocal: (libraryRoot: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('setup:use-local', String(libraryRoot)),
  connect: (url: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('setup:connect', String(url)),
  cancel: (): Promise<void> => ipcRenderer.invoke('setup:cancel'),
  restart: (): Promise<void> => ipcRenderer.invoke('status:restart'),
  changeMode: (): Promise<void> => ipcRenderer.invoke('status:change-mode'),
});
