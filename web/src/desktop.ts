import type {
  AppleBooksImportResult,
  AppleBooksRawData,
  AppleBooksWriteField,
  AppleBooksWriteStatus,
  BookMeta,
} from '@shared/types';
import { api, withLibrary } from './api';
import { useStore } from './store';

/** Esito di una chiamata al ponte: gli errori non passano come eccezioni (l'IPC ne perde i dettagli). */
export type DesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'running' | 'failed'; message: string };

/** Ponte esposto dall'app per Mac (preload). Nel browser non esiste. */
export interface BooksDesktop {
  info(): Promise<{ version: string; appleBooks: boolean }>;
  appleBooksRead(): Promise<DesktopResult<AppleBooksRawData>>;
  appleBooksStatus(meta: BookMeta): Promise<DesktopResult<AppleBooksWriteStatus>>;
  appleBooksWrite(args: {
    meta: BookMeta;
    fields: AppleBooksWriteField[];
    quitApp: boolean;
    cover?: ArrayBuffer;
  }): Promise<DesktopResult<{ written: AppleBooksWriteField[]; backup: string; reopened: boolean }>>;
  openInBooks(args: { data: ArrayBuffer; filename: string }): Promise<DesktopResult<{ path: string }>>;
}

declare global {
  interface Window {
    booksDesktop?: BooksDesktop;
  }
}

/** Il ponte dell'app per Mac, se la pagina gira dentro l'app. */
export function desktop(): BooksDesktop | undefined {
  return typeof window === 'undefined' ? undefined : window.booksDesktop;
}

/** Errore del ponte con il codice (`running` = Apple Books e' aperto). */
export class DesktopError extends Error {
  code: 'running' | 'failed';
  constructor(message: string, code: 'running' | 'failed') {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
  }
}

/** Estrae il valore di una risposta del ponte o lancia DesktopError. */
export function unwrap<T>(result: DesktopResult<T>): T {
  if (!result.ok) throw new DesktopError(result.message, result.code);
  return result.value;
}

/** Legge Apple Books sul Mac (app) e lo importa nella libreria del server. */
export async function importAppleBooksViaApp(
  options: { dryRun?: boolean; bookIds?: string[] } = {},
): Promise<AppleBooksImportResult> {
  const bridge = desktop();
  if (!bridge) throw new Error('Disponibile nell\'app per Mac');
  const data = unwrap(await bridge.appleBooksRead());
  return api.importAppleBooksData(data, options);
}

/**
 * Dopo un'importazione riuscita l'app per Mac legge Apple Books e abbina sottolineature,
 * avanzamento e date ai libri appena aggiunti. Gli errori restano in console.
 */
export async function syncAppleBooksFromApp(bookIds: string[]): Promise<void> {
  if (!bookIds.length || !desktop()) return;
  try {
    // Con il server in locale sul Mac la sincronizzazione la fa gia' lui.
    if ((await api.appleBooksCapabilities()).local) return;
    const result = await importAppleBooksViaApp({ bookIds });
    if (result.booksUpdated > 0) {
      const store = useStore.getState();
      await store.load();
      if (store.selectedId && bookIds.includes(store.selectedId)) await store.reloadBook(store.selectedId);
    }
  } catch (error) {
    console.warn('[applebooks] sincronizzazione saltata:', (error as Error).message);
  }
}

/** Scarica un file dell'API come ArrayBuffer (URL con la libreria attiva). */
export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(withLibrary(url));
  if (!response.ok) throw new Error(`Download non riuscito (${response.status})`);
  return response.arrayBuffer();
}
