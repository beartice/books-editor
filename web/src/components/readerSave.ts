import { useEffect, useMemo } from 'react';
import { api, withLibrary } from '../api';
import { useStore } from '../store';

/** Attesa dopo l'ultimo cambio di posizione prima di salvare sul server. */
const SAVE_DELAY_MS = 3000;
/** Anche girando pagina di continuo, almeno un salvataggio ogni tanto. */
const SAVE_MAX_WAIT_MS = 15000;

export interface PositionSaver {
  /** Registra la posizione corrente; il salvataggio parte dopo qualche secondo. */
  update: (location: string, progress: number) => void;
  /** Salva subito la posizione non ancora salvata (chiusura del lettore). */
  flush: () => void;
}

interface Pending {
  location: string;
  progress: number;
}

/**
 * Salvataggio della posizione di lettura: debounce di qualche secondo, salvataggio
 * immediato alla chiusura e `sendBeacon` quando la pagina sta per sparire.
 */
export function usePositionSaver(id: string, file: string): PositionSaver {
  const saver = useMemo(() => {
    let pending: Pending | null = null;
    let timer: number | null = null;
    let firstPendingAt = 0;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };

    const body = (item: Pending) => ({ file, location: item.location, progress: item.progress });

    const save = () => {
      clearTimer();
      if (!pending) return;
      const item = pending;
      pending = null;
      api
        .saveReadingPosition(id, body(item))
        .then(() => useStore.getState().applyReadingProgress(id, item.progress))
        .catch((error) => {
          // Si riprova al prossimo cambio di posizione, a meno che nel frattempo ce ne sia una piu' recente.
          pending ??= item;
          console.warn('[lettore] posizione non salvata:', (error as Error).message);
        });
    };

    // Chiusura della pagina: una normale fetch verrebbe interrotta, il beacon no.
    const beacon = () => {
      clearTimer();
      if (!pending) return;
      const item = pending;
      pending = null;
      const payload = new Blob([JSON.stringify(body(item))], { type: 'application/json' });
      const sent = navigator.sendBeacon?.(withLibrary(`/api/books/${encodeURIComponent(id)}/reading-position`), payload);
      if (!sent) pending = item;
    };

    return {
      update(location: string, progress: number) {
        if (!pending) firstPendingAt = Date.now();
        pending = { location, progress };
        clearTimer();
        const wait = Math.max(0, Math.min(SAVE_DELAY_MS, firstPendingAt + SAVE_MAX_WAIT_MS - Date.now()));
        timer = window.setTimeout(save, wait);
      },
      flush: save,
      beacon,
      dispose: clearTimer,
    };
  }, [id, file]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') saver.beacon();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', saver.beacon);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', saver.beacon);
      // Chiusura del lettore: se resta una posizione non salvata, parte ora.
      saver.flush();
      saver.dispose();
    };
  }, [saver]);

  return saver;
}
