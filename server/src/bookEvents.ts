import type { LibraryInfo } from './libraries.js';

/*
 * Avvisi sulle schede: chi modifica una scheda (library.ts, efp.ts...) segnala
 * l'evento, chi vuole reagire (l'invio a Jellyfin) si registra. Un modulo a parte
 * evita import circolari fra libreria e sincronizzazione.
 */

export type BookEventReason = 'changed' | 'new';

type Listener = (library: LibraryInfo, bookId: string, reason: BookEventReason) => void;

let listener: Listener | null = null;

export function onBookEvent(next: Listener | null): void {
  listener = next;
}

/** Segnala una scheda nuova o modificata. Non solleva mai errori e non aspetta nessuno. */
export function notifyBook(library: LibraryInfo, bookId: string, reason: BookEventReason): void {
  try {
    listener?.(library, bookId, reason);
  } catch (error) {
    console.error('[jellyfin] avviso della scheda non gestito:', error);
  }
}
