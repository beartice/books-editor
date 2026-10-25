import type {
  AppleBooksImportResult,
  AppleBooksRawData,
  AppleBooksWriteField,
  AppleBooksWriteStatus,
  BookMeta,
} from '@shared/types';
import { api, withLibrary } from './api';
import { storeAppleAutoSync, useStore } from './store';

/** Esito di una chiamata al ponte: gli errori non passano come eccezioni (l'IPC ne perde i dettagli). */
export type DesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'running' | 'failed'; message: string };

/** Ponte esposto dall'app desktop (preload). Nel browser non esiste. */
export interface BooksDesktop {
  /** Vero solo sul Mac: su Windows Apple Books non c'e' e le sue funzioni restano nascoste. */
  readonly appleBooks: boolean;
  /** `localServer`: il server gira dentro l'app (modalita' locale); `appleBooks` come sopra. */
  info(): Promise<DesktopResult<{ version: string; appleBooks: boolean; localServer: boolean }>>;
  /** Finestra di scelta cartella (solo in modalita' locale); `null` se l'utente annulla. */
  pickFolder(): Promise<DesktopResult<{ path: string | null }>>;
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

/** Il ponte se esiste e se l'app puo' parlare con Apple Books (Mac); su Windows `undefined`. */
export function appleBridge(): BooksDesktop | undefined {
  const bridge = desktop();
  // `!== false`: le versioni vecchie dell'app non espongono il campo e girano solo sul Mac.
  return bridge && bridge.appleBooks !== false ? bridge : undefined;
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
  const bridge = appleBridge();
  if (!bridge) throw new Error('Disponibile nell\'app per Mac');
  const data = unwrap(await bridge.appleBooksRead());
  return api.importAppleBooksData(data, options);
}

/**
 * Dopo un'importazione riuscita l'app per Mac legge Apple Books e abbina sottolineature,
 * avanzamento e date ai libri appena aggiunti. Gli errori restano in console.
 */
export async function syncAppleBooksFromApp(bookIds: string[]): Promise<void> {
  if (!bookIds.length || !appleBridge()) return;
  try {
    // Con il server in locale sul Mac la sincronizzazione la fa gia' lui.
    if ((await api.appleBooksCapabilities()).local) return;
    const result = await importAppleBooksViaApp({ bookIds });
    if (result.booksUpdated > 0) {
      const store = useStore.getState();
      await store.refreshBooks();
      if (store.selectedId && bookIds.includes(store.selectedId)) await store.reloadBook(store.selectedId);
    }
  } catch (error) {
    console.warn('[applebooks] sincronizzazione saltata:', (error as Error).message);
  }
}

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const SYNC_MIN_GAP_MS = 5 * 60 * 1000;

/** Tempi della sincronizzazione; per le prove si possono ridurre con la chiave `books-editor.appleSyncTest` (JSON). */
function syncTimings(): { intervalMs: number; minGapMs: number } {
  try {
    const raw = JSON.parse(localStorage.getItem('books-editor.appleSyncTest') ?? 'null') as {
      intervalMs?: number;
      minGapMs?: number;
    } | null;
    return {
      intervalMs: raw?.intervalMs ?? SYNC_INTERVAL_MS,
      minGapMs: raw?.minGapMs ?? SYNC_MIN_GAP_MS,
    };
  } catch {
    return { intervalMs: SYNC_INTERVAL_MS, minGapMs: SYNC_MIN_GAP_MS };
  }
}

let stopAutoSync: (() => void) | null = null;
let autoSyncStarting = false;
let readErrorShown = false;

/**
 * Un giro di sincronizzazione: legge Apple Books una volta e importa i dati in ogni
 * libreria. Ricarica in silenzio la libreria aperta se qualcosa e' cambiato.
 */
async function runAppleSync(bridge: BooksDesktop): Promise<void> {
  const read = await bridge.appleBooksRead();
  if (!read.ok) {
    console.warn('[applebooks] lettura non riuscita:', read.message);
    // Un solo avviso per sessione, e solo se sembra il permesso di macOS negato
    // (messaggi di `sqliteJson` e `locateDatabases`).
    if (!readErrorShown && read.code !== 'running' && /Lettura del database|non trovato/.test(read.message)) {
      readErrorShown = true;
      useStore
        .getState()
        .toast(
          'Consenti a Books Editor l\'accesso ai dati delle altre app in Impostazioni di Sistema → Privacy e sicurezza',
          'info',
        );
    }
    return;
  }
  const libraries = await api.libraries();
  let updatedInOpen = 0;
  let updatedTotal = 0;
  let succeeded = 0;
  const openId = useStore.getState().libraryId;
  for (const library of libraries) {
    try {
      const result = await api.importAppleBooksData(read.value, { libraryId: library.id });
      updatedTotal += result.booksUpdated;
      succeeded += 1;
      if (library.id === openId) updatedInOpen += result.booksUpdated;
    } catch (error) {
      console.warn(`[applebooks] libreria ${library.id}:`, (error as Error).message);
    }
  }
  // «Ultima sincronizzazione» solo se almeno una libreria e' andata a buon fine.
  if (succeeded > 0) {
    useStore.setState((state) => ({
      appleSync: { ...state.appleSync, lastAt: Date.now(), updated: updatedTotal },
    }));
  }
  if (updatedInOpen > 0 && useStore.getState().libraryId === openId) await refreshAfterSync();
}

/** Aggiorna lista e statistiche; il dettaglio aperto riceve solo i campi di Apple Books. */
async function refreshAfterSync(): Promise<void> {
  const before = useStore.getState();
  await before.refreshBooks();
  const id = before.selectedId;
  if (!id || before.busy) return;
  try {
    const fresh = await api.book(id);
    useStore.setState((state) => {
      // Libro cambiato o salvataggio iniziato nel frattempo: non si tocca il pannello.
      if (state.selectedId !== id || !state.detail || state.detail.id !== id || state.busy) return state;
      // Solo i campi scritti dall'import: le modifiche in corso negli altri restano.
      const { highlights, identifiers, dateFinished, readingStatus, readingProgress } = fresh;
      return {
        detail: { ...state.detail, highlights, identifiers, dateFinished, readingStatus, readingProgress },
      };
    });
  } catch (error) {
    console.warn('[applebooks] dettaglio non aggiornato:', (error as Error).message);
  }
}

/**
 * Sincronizzazione automatica con Apple Books nell'app per Mac: subito, ogni 15 minuti e
 * quando la finestra torna in primo piano (almeno 5 minuti fra due giri). Non fa nulla nel
 * browser, con il server in locale sul Mac o se l'utente l'ha spenta.
 */
export function startAppleBooksAutoSync(): void {
  const bridge = appleBridge();
  if (!bridge || stopAutoSync || autoSyncStarting || !useStore.getState().appleSync.enabled) return;
  autoSyncStarting = true;
  void (async () => {
    try {
      // Con il server in locale sul Mac la sincronizzazione la fa gia' lui.
      if ((await api.appleBooksCapabilities()).local) return;
    } catch (error) {
      console.warn('[applebooks] sincronizzazione automatica non avviata:', (error as Error).message);
      return;
    } finally {
      autoSyncStarting = false;
    }
    // Spenta o fermata mentre si attendeva la risposta.
    if (stopAutoSync || !useStore.getState().appleSync.enabled) return;

    const { intervalMs, minGapMs } = syncTimings();
    let running = false;
    let lastStart = 0;
    const tick = async (force: boolean) => {
      if (running) return;
      if (!force && Date.now() - lastStart < minGapMs) return;
      running = true;
      lastStart = Date.now();
      try {
        await runAppleSync(bridge);
      } catch (error) {
        console.warn('[applebooks] sincronizzazione saltata:', (error as Error).message);
      } finally {
        running = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick(false);
    };
    const onFocus = () => void tick(false);
    const timer = window.setInterval(() => void tick(true), intervalMs);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    stopAutoSync = () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      stopAutoSync = null;
    };
    void tick(true);
  })();
}

export function stopAppleBooksAutoSync(): void {
  stopAutoSync?.();
}

/** Interruttore delle Impostazioni: salva la scelta e ferma o fa ripartire il timer. */
export function setAppleAutoSync(enabled: boolean): void {
  storeAppleAutoSync(enabled);
  useStore.setState((state) => ({ appleSync: { ...state.appleSync, enabled } }));
  if (enabled) startAppleBooksAutoSync();
  else stopAppleBooksAutoSync();
}

/** Scarica un file dell'API come ArrayBuffer (URL con la libreria attiva). */
export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(withLibrary(url));
  if (!response.ok) throw new Error(`Download non riuscito (${response.status})`);
  return response.arrayBuffer();
}
