import { contextBridge, ipcRenderer } from 'electron';

// Ponte della sola pagina di configurazione (file locale dell'app).
contextBridge.exposeInMainWorld('booksSetup', {
  current: (): Promise<string> => ipcRenderer.invoke('setup:current'),
  connect: (url: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('setup:connect', String(url)),
  cancel: (): Promise<void> => ipcRenderer.invoke('setup:cancel'),
});
