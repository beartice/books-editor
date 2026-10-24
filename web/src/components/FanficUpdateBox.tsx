import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { cn, formatDate } from '../utils';
import { IconRefresh } from './icons';
import { isFanficUpdateAvailable } from '@shared/types';
import type { BookMeta } from '@shared/types';

/** Data e ora locali, ad esempio «24 ott 2026, 03:12». */
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Esito del controllo dei nuovi capitoli di una fanfiction. L'app avvisa soltanto:
 * la storia si aggiorna solo con «Aggiorna storia».
 */
export default function FanficUpdateBox({ meta }: { meta: BookMeta }) {
  const reloadBook = useStore((state) => state.reloadBook);
  const toast = useStore((state) => state.toast);
  const [working, setWorking] = useState<'update' | 'dismiss' | null>(null);

  const update = meta.fanficUpdate;
  if (meta.kind !== 'fanfic' || !update) return null;
  const available = isFanficUpdateAvailable(update);

  const run = async (action: 'update' | 'dismiss') => {
    setWorking(action);
    try {
      const updated =
        action === 'update' ? await api.fanficUpdate(meta.id) : await api.fanficDismiss(meta.id);
      useStore.setState({ detail: updated });
      await reloadBook(meta.id);
      toast(
        action === 'update'
          ? `Storia aggiornata: ${updated.chapters ?? '?'} capitoli`
          : 'Avviso ignorato fino al prossimo capitolo',
        'success',
      );
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setWorking(null);
    }
  };

  const remote = `${update.remoteChapters ?? '?'} su ${update.remoteTotal ?? '?'}`;
  const headline =
    update.newChapters > 0
      ? `Nuovi capitoli disponibili: ${remote} (prima ${meta.chapters ?? '?'})`
      : `Storia completata sul sito: ${update.remoteChapters ?? '?'} capitoli`;

  return (
    <div className="space-y-2">
      {available && (
        <div className="rounded-xl border border-coral-500/30 bg-coral-500/[0.07] p-3">
          <p className="text-[13px] font-semibold text-ink-100">
            {headline}
            {update.newChapters > 0 && update.completed && ' · ora completa'}
            {update.remoteUpdated && (
              <span className="font-normal text-ink-400">
                {' '}
                · aggiornata il {formatDate(update.remoteUpdated)}
              </span>
            )}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void run('update')}
              disabled={working !== null}
              className="btn-primary text-[13px] disabled:opacity-60"
              title="Scarica di nuovo la storia dal sito: voto, stato di lettura e sottolineature restano"
            >
              <IconRefresh className={cn('h-4 w-4', working === 'update' && 'animate-spin')} />
              {working === 'update' ? 'Aggiornamento in corso…' : 'Aggiorna storia'}
            </button>
            <button
              onClick={() => void run('dismiss')}
              disabled={working !== null}
              className="btn-ghost text-[13px] disabled:opacity-60"
              title="Nasconde l'avviso finché non arrivano altri capitoli"
            >
              Ignora
            </button>
          </div>
        </div>
      )}
      {update.error && (
        <p className="px-1 text-[11.5px] text-amber-700">
          Ultimo controllo non riuscito: {update.error}
        </p>
      )}
      <p className="px-1 text-[11px] text-ink-500">
        Ultimo controllo: {formatDateTime(update.checkedAt)}
      </p>
    </div>
  );
}
