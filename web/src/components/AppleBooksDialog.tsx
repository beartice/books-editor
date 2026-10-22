import { useState } from 'react';
import { api, ApiError } from '../api';
import { DesktopError, desktop, fetchBuffer, unwrap } from '../desktop';
import { useStore } from '../store';
import { IconClose } from './icons';
import type { AppleBooksWriteField, AppleBooksWriteStatus, BookMeta } from '@shared/types';

/** Pannello di conferma per «Scrivi su Apple Books»: si scelgono i campi e si vede cosa cambia. */
export default function AppleBooksDialog({
  meta,
  status,
  onClose,
}: {
  meta: BookMeta;
  status: AppleBooksWriteStatus;
  onClose: () => void;
}) {
  const asset = status.asset;
  const [fields, setFields] = useState<Record<AppleBooksWriteField, boolean>>({
    cover: !!meta.coverFile,
    title: true,
    authors: meta.authors.length > 0,
  });
  const [busy, setBusy] = useState(false);
  // Impostato quando il server risponde 409: Apple Books e' aperto.
  const [running, setRunning] = useState(false);

  const chosen = (Object.keys(fields) as AppleBooksWriteField[]).filter((key) => fields[key]);

  const submit = async (quitApp: boolean) => {
    setBusy(true);
    try {
      const bridge = desktop();
      let result: { reopened: boolean };
      if (bridge) {
        // App per Mac: la copertina si scarica qui (con il cookie di sessione) e la scrittura avviene sul Mac.
        const cover =
          chosen.includes('cover') && meta.coverFile
            ? await fetchBuffer(`/api/covers/${meta.id}?v=${encodeURIComponent(meta.coverFile)}`)
            : undefined;
        result = unwrap(await bridge.appleBooksWrite({ meta, fields: chosen, quitApp, cover }));
      } else {
        result = await api.writeAppleBooks(meta.id, chosen, quitApp);
      }
      useStore
        .getState()
        .toast(
          result.reopened
            ? 'Scritto su Apple Books (app riaperta). Backup salvato.'
            : 'Scritto su Apple Books. Riaprilo per vedere le modifiche. Backup salvato.',
          'success',
        );
      onClose();
    } catch (error) {
      if (
        (error instanceof ApiError && error.status === 409) ||
        (error instanceof DesktopError && error.code === 'running')
      ) {
        setRunning(true);
      }
      else useStore.getState().toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const rows: { key: AppleBooksWriteField; label: string; current: string; next: string; disabled: boolean }[] = [
    {
      key: 'cover',
      label: 'Copertina',
      current: '',
      next: 'sostituita con quella della scheda',
      disabled: !meta.coverFile,
    },
    { key: 'title', label: 'Titolo', current: asset?.title ?? '', next: meta.title, disabled: false },
    {
      key: 'authors',
      label: 'Autore',
      current: asset?.author ?? '',
      next: meta.authors.join(', '),
      disabled: meta.authors.length === 0,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink-950/25 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div className="relative h-[100dvh] w-full max-w-lg animate-scale-in overflow-y-auto border-black/[0.07] bg-white p-5 shadow-panel sm:h-auto sm:max-h-[90vh] sm:rounded-[24px] sm:border sm:p-6">
        <div className="sticky top-0 z-10 -mx-5 -mt-5 mb-4 flex items-center justify-between bg-white px-5 py-3 sm:static sm:mx-0 sm:mt-0 sm:px-0 sm:py-0">
          <h2 className="text-lg font-semibold text-ink-50">Scrivi su Apple Books</h2>
          <button onClick={onClose} className="btn-subtle h-10 w-10 px-0 sm:h-auto sm:w-auto sm:px-2" aria-label="Chiudi">
            <IconClose />
          </button>
        </div>

        <div className="space-y-2">
          {rows.map((row) => (
            <label
              key={row.key}
              className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-black/[0.07] bg-ink-800 px-3 py-2 text-[13px]"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={fields[row.key] && !row.disabled}
                disabled={row.disabled || busy}
                onChange={(event) => setFields({ ...fields, [row.key]: event.target.checked })}
              />
              <span className="min-w-0">
                <span className="font-medium text-ink-100">{row.label}</span>
                <span className="block break-words text-ink-300">
                  {row.current ? (
                    <>
                      {row.current} <span className="text-ink-400">→</span> {row.next}
                    </>
                  ) : (
                    row.next
                  )}
                </span>
              </span>
            </label>
          ))}
        </div>

        <p className="mt-3 text-[12px] text-ink-300">
          Sottolineature, posizione e collezioni restano. Viene fatto un backup.
        </p>
        {running && (
          <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-[12px] text-ink-200">
            Apple Books e' aperto. Per scrivere va chiuso (verra' riaperto alla fine).
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost px-3 py-1.5 text-[13px]" disabled={busy}>
            Annulla
          </button>
          {running ? (
            <button
              onClick={() => void submit(true)}
              className="btn-primary px-3 py-1.5 text-[13px] disabled:opacity-60"
              disabled={busy || !chosen.length}
            >
              Chiudi Apple Books e scrivi
            </button>
          ) : (
            <button
              onClick={() => void submit(false)}
              className="btn-primary px-3 py-1.5 text-[13px] disabled:opacity-60"
              disabled={busy || !chosen.length}
            >
              Scrivi
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
