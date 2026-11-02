import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecommendationsResult } from '@shared/types';
import { api } from './api';
import { useStore } from './store';

/**
 * Carica i suggerimenti: li ricarica al cambio libreria, a ogni richiesta (`attempt`), quando
 * si chiude la scheda di un libro (lo stato potrebbe essere cambiato) e quando si chiude la
 * vista «Cosa leggere dopo». Con `enabled` falso non chiede
 * nulla (la home con filtri attivi). Durante la ricarica l'elenco precedente resta visibile.
 */
export function useRecommendations(enabled = true, limit?: number) {
  const libraryId = useStore((state) => state.libraryId);
  const selectedId = useStore((state) => state.selectedId);
  const [data, setData] = useState<RecommendationsResult | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const viewOpen = useStore((state) => state.recommendationsOpen);
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
    if (!enabled) return;
    let cancelled = false;
    setError('');
    api
      .recommendations(limit)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((failure) => {
        if (!cancelled) setError((failure as Error).message || 'Impossibile leggere i suggerimenti');
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, attempt, enabled, limit]);

  // Cambio libreria: i suggerimenti dell'altra non servono piu'.
  useEffect(() => {
    setData(null);
  }, [libraryId]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { data, error, reload };
}
