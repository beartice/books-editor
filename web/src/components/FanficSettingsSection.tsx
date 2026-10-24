import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { FanficCheckState } from '@shared/types';

/** Data e ora locali, ad esempio «24 ott 2026, 03:12». */
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Controllo dei nuovi capitoli delle fanfiction (AO3, EFP): avvio manuale e stato
 * del giro. Mentre il giro e' in corso lo stato si rilegge ogni 3 secondi.
 */
export default function FanficSettingsSection() {
  const refreshBooks = useStore((state) => state.refreshBooks);
  const toast = useStore((state) => state.toast);
  const [state, setState] = useState<FanficCheckState | null>(null);
  const [starting, setStarting] = useState(false);
  // Cambia all'avvio di un giro: il ciclo di lettura dello stato riparte subito (ogni 3 s).
  const [restart, setRestart] = useState(0);
  const wasRunning = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.fanficCheckState();
        if (cancelled) return;
        // Finito il giro: l'elenco si ricarica per mostrare le etichette sulle card.
        if (wasRunning.current && !next.running) void refreshBooks();
        wasRunning.current = next.running;
        setState(next);
        timer = window.setTimeout(poll, next.running ? 3000 : 15000);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 15000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshBooks, restart]);

  const start = async () => {
    setStarting(true);
    try {
      const next = await api.fanficCheck(false);
      wasRunning.current = next.running;
      setState(next);
      setRestart((value) => value + 1);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const running = state?.running ?? false;

  return (
    <div className="rounded-lg border border-black/[0.06] bg-ink-800 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="field-label !mb-0">Fanfiction</span>
        <span className="chip border-black/[0.08] text-ink-400">AO3 · EFP</span>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-500">
        Controlla se le fanfiction in corso hanno nuovi capitoli o sono state completate. L'app
        avvisa soltanto: la storia si aggiorna dalla sua scheda.
      </p>
      <button
        type="button"
        onClick={start}
        disabled={running || starting}
        className="btn-ghost mt-2 text-[12px] disabled:opacity-60"
      >
        {running || starting ? 'Controllo in corso…' : 'Controlla aggiornamenti ora'}
      </button>
      {state && running && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-300">
          In corso: {state.done} di {state.total} · trovati {state.found} · errori {state.errors}
        </p>
      )}
      {state && !running && state.finishedAt && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          Ultimo giro: {state.done} opere controllate, trovati {state.found}, errori {state.errors}.
          {state.stopReason && <span className="text-amber-700"> {state.stopReason}.</span>}
        </p>
      )}
      {state && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
          {state.lastRunAt
            ? `Completato il ${formatDateTime(state.lastRunAt)}.`
            : 'Nessun giro ancora completato.'}{' '}
          {state.automatic
            ? `Ogni notte alle ${String(state.hour).padStart(2, '0')}:00 (ora del server) il controllo parte da solo su tutte le librerie, con una pausa fra una richiesta e l'altra.`
            : 'Il controllo notturno automatico è disattivato.'}
        </p>
      )}
    </div>
  );
}
