import { useCallback, useEffect, useRef, useState } from 'react';
import type { MonthlyPickResult } from '@shared/types';
import { api } from './api';
import { useStore } from './store';

/**
 * Carica il «Libro del mese»: lo ricarica al cambio libreria, a ogni richiesta, quando si
 * chiude la scheda di un libro (potrebbe essere stato iniziato o finito) e quando si chiude la
 * vista «Cosa leggere dopo». Con `enabled` falso non chiede nulla. Errori di rete: nessun dato.
 */
export function useMonthlyPick(enabled = true) {
  const libraryId = useStore((state) => state.libraryId);
  const selectedId = useStore((state) => state.selectedId);
  const viewOpen = useStore((state) => state.recommendationsOpen);
  const [data, setData] = useState<MonthlyPickResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const previousSelected = useRef(selectedId);
  const previousViewOpen = useRef(viewOpen);

  useEffect(() => {
    if (previousSelected.current && !selectedId) setAttempt((value) => value + 1);
    previousSelected.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (previousViewOpen.current && !viewOpen) setAttempt((value) => value + 1);
    previousViewOpen.current = viewOpen;
  }, [viewOpen]);

  useEffect(() => {
    setData(null);
  }, [libraryId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .monthlyPick()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [libraryId, attempt, enabled]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { data, setData, reload };
}
