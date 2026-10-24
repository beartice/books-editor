import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { JellyfinLibrary } from '../api';
import { useStore } from '../store';
import type { JellyfinSyncState } from '@shared/types';

/** Data e ora locali, ad esempio «24 ott 2026, 03:12». */
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

const PHASES: Record<NonNullable<JellyfinSyncState['phase']>, string> = {
  ignore: 'Preparo i file secondari',
  match: 'Abbino i libri di Jellyfin',
  push: 'Invio i metadati',
};

/**
 * Jellyfin legge la cartella delle librerie; qui si sceglie la sua libreria dei libri,
 * si attiva l'invio automatico dei metadati e si lancia l'aggiornamento completo.
 * Mentre il giro e' in corso lo stato si rilegge ogni 2 secondi.
 */
export default function JellyfinSyncSection() {
  const settings = useStore((state) => state.settings);
  const toast = useStore((state) => state.toast);
  const refreshBooks = useStore((state) => state.refreshBooks);
  const [libraries, setLibraries] = useState<JellyfinLibrary[]>([]);
  const [loadingLibraries, setLoadingLibraries] = useState(false);
  const [state, setState] = useState<JellyfinSyncState | null>(null);
  const [starting, setStarting] = useState(false);
  const [restart, setRestart] = useState(0);
  const wasRunning = useRef(false);

  const ready = Boolean(settings?.jellyfinUrl && settings?.jellyfinApiKeySet);

  useEffect(() => {
    if (!ready) return;
    setLoadingLibraries(true);
    api
      .jellyfinLibraries()
      .then(setLibraries)
      .catch((error) => toast((error as Error).message, 'error'))
      .finally(() => setLoadingLibraries(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, settings?.jellyfinUrl]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.jellyfinSyncState();
        if (cancelled) return;
        // Finito il giro: le schede portano lo stato dell'ultimo invio, si ricaricano.
        if (wasRunning.current && !next.running) void refreshBooks();
        wasRunning.current = next.running;
        setState(next);
        timer = window.setTimeout(poll, next.running ? 2000 : 15000);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 15000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ready, refreshBooks, restart, settings?.jellyfinBooksLibraryId]);

  if (!settings) return null;

  const save = async (patch: { jellyfinBooksLibraryId?: string; jellyfinPushEnabled?: boolean }) => {
    try {
      const saved = await api.updateSettings(patch);
      useStore.setState({ settings: saved });
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  const start = async (force: boolean) => {
    setStarting(true);
    try {
      const next = await api.jellyfinSync(force);
      wasRunning.current = next.running;
      setState(next);
      setRestart((value) => value + 1);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const libraryId = settings.jellyfinBooksLibraryId ?? '';
  const running = state?.running ?? false;
  const pushEnabled = settings.jellyfinPushEnabled !== false;
  // Se la libreria salvata non e' fra quelle dei libri, la si mostra comunque.
  const options = libraries.some((library) => library.id === libraryId) || !libraryId
    ? libraries
    : [{ id: libraryId, name: 'Libreria salvata', type: '' }, ...libraries];

  return (
    <div className="rounded-lg border border-black/[0.06] bg-ink-800 p-3" data-testid="jellyfin-sync">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="field-label !mb-0">Jellyfin: invio dei metadati</span>
        {state?.configured ? (
          <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-700">attivo</span>
        ) : (
          <span className="chip border-amber-500/30 bg-amber-500/10 text-amber-700">da impostare</span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-ink-500">
        Jellyfin legge direttamente la cartella delle librerie (anche le fanfiction); questa app
        resta l'unica a scrivere i file e gli invia titolo, autori, descrizione, generi, tag, serie
        e copertina.
      </p>
      {!ready ? (
        <p className="mt-2 text-[11px] text-amber-700">
          Imposta indirizzo e chiave API di Jellyfin e salva, poi scegli la libreria dei libri.
        </p>
      ) : (
        <>
          <label className="mt-2 block">
            <span className="field-label">Libreria Jellyfin dei libri</span>
            <select
              value={libraryId}
              onChange={(event) => void save({ jellyfinBooksLibraryId: event.target.value })}
              disabled={loadingLibraries}
              className="field-input text-[12px]"
              data-testid="jellyfin-library"
            >
              <option value="">{loadingLibraries ? 'Carico…' : 'Scegli una libreria…'}</option>
              {options.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                  {library.type === 'books' || !library.type ? '' : ` (${library.type})`}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-2 flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={pushEnabled}
              onChange={(event) => void save({ jellyfinPushEnabled: event.target.checked })}
              className="mt-0.5"
              data-testid="jellyfin-auto"
            />
            <span>
              <span className="block text-sm text-ink-100">Invia automaticamente i metadati</span>
              <span className="block text-[11px] text-ink-500">
                Dopo ogni modifica di una scheda (pochi secondi dopo) e, per i libri nuovi, dopo
                un aggiornamento della libreria di Jellyfin.
              </span>
            </span>
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void start(false)}
              disabled={running || starting || !libraryId}
              className="btn-ghost text-[12px] disabled:opacity-60"
              data-testid="jellyfin-sync-now"
            >
              {running || starting ? 'Aggiornamento in corso…' : 'Aggiorna Jellyfin ora'}
            </button>
            <button
              type="button"
              onClick={() => void start(true)}
              disabled={running || starting || !libraryId}
              className="text-[11px] text-ink-400 underline decoration-black/20 hover:text-ink-200 disabled:opacity-60"
            >
              Reinvia tutto
            </button>
          </div>

          {state && running && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-300">
              {state.phase ? PHASES[state.phase] : 'In corso'}
              {state.phase === 'push' ? `: ${state.done} di ${state.total}` : '…'} · inviate{' '}
              {state.pushed} · errori {state.errors}
            </p>
          )}
          {state && !running && state.finishedAt && (
            <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
              Ultimo giro: inviate {state.pushed}, invariate {state.skipped}, errori {state.errors}.
            </p>
          )}
          {state?.error && (
            <p className="mt-1 text-[11px] leading-relaxed text-rose-600/90">{state.error}</p>
          )}
          {state && state.configured && (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500" data-testid="jellyfin-status">
              Abbinate {state.matchedBooks} schede
              {state.matchedAt
                ? ` · ${state.unmatchedCount} elementi Jellyfin senza scheda`
                : ' · abbinamento non ancora eseguito'}
              {state.secondaryItems > 0
                ? ` · ${state.secondaryItems} ${state.secondaryItems === 1 ? 'file secondario' : 'file secondari'} (si nasconde con la prossima scansione di Jellyfin)`
                : ''}
              {state.booksWithError > 0 ? ` · ${state.booksWithError} con errore` : ''}
              {' · '}
              {state.lastPushAt ? `ultimo invio ${formatDateTime(state.lastPushAt)}` : 'nessun invio ancora'}
            </p>
          )}
          {state?.configured && !state.pathMapSet && (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
              Nessuna mappatura dei percorsi (JELLYFIN_PATH_MAP): i file si abbinano solo se
              Jellyfin e questa app li vedono allo stesso percorso.
            </p>
          )}
          {state && state.unmatchedCount > 0 && (
            <details className="mt-2 text-[11px] text-ink-400" data-testid="jellyfin-unmatched">
              <summary className="cursor-pointer">Elementi Jellyfin senza scheda</summary>
              <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-black/[0.06] bg-ink-900/40 p-2">
                {state.unmatched.map((item) => (
                  <div key={item.id} className="break-all">
                    <span className="text-ink-200">{item.name}</span>
                    <span className="block font-mono text-[10px] text-ink-500">{item.path}</span>
                    {item.reason === 'unmapped' && (
                      <span className="block text-[10px] text-amber-700">
                        Fuori dalla mappatura dei percorsi
                      </span>
                    )}
                  </div>
                ))}
                {state.unmatchedCount > state.unmatched.length && (
                  <div className="text-ink-500">
                    …e altri {state.unmatchedCount - state.unmatched.length}
                  </div>
                )}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
