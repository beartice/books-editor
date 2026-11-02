import { useEffect, useRef, useState } from 'react';
import type { BookMeta } from '@shared/types';
import { setLeaveGuard, useStore } from '../store';
import { formatDateLong } from '../utils';

/** Lunghezza massima della recensione; il contatore compare oltre `COUNTER_FROM`. */
const NOTES_MAX = 20000;
const COUNTER_FROM = 18000;

interface Props {
  meta: BookMeta;
  commit: (patch: Partial<BookMeta>) => Promise<void>;
}

/**
 * «La tua recensione»: le note personali del libro (`notes`). Salvataggio esplicito, Esc annulla
 * solo la modifica, e con testo non salvato chiudere la scheda o cambiare libro chiede conferma.
 * Restano private: non vanno a Jellyfin, nei file ne' su Apple Books.
 */
export default function ReviewCard({ meta, commit }: Props) {
  const confirm = useStore((state) => state.confirm);
  const saved = meta.notes ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = editing && draft !== saved;

  // Cambio libro: la modifica in corso non passa all'altro.
  useEffect(() => {
    setEditing(false);
  }, [meta.id]);

  // La casella cresce con il testo (minimo 5 righe).
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draft, editing]);

  // Con testo non salvato, chiudere la scheda o aprirne un'altra chiede conferma.
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard(async () => {
      const answer = await confirm('Hai una recensione non salvata. Vuoi scartarla?', [
        { label: 'Scarta', value: 'discard', primary: true },
        { label: 'Continua a scrivere', value: 'keep' },
      ]);
      return answer === 'discard';
    });
    return () => setLeaveGuard(null);
  }, [dirty, confirm]);

  const start = () => {
    setDraft(saved);
    setEditing(true);
    window.setTimeout(() => area.current?.focus(), 0);
  };

  const save = async () => {
    const next = draft.trim();
    setSaving(true);
    try {
      await commit({ notes: next });
      // Se il server ha rifiutato la modifica (errore gia' segnalato) si resta in modifica.
      if ((useStore.getState().detail?.notes ?? '') === next) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const answer = await confirm('Eliminare la recensione?', [
      { label: 'Elimina', value: 'delete', primary: true },
      { label: 'Annulla', value: 'cancel' },
    ]);
    if (answer === 'delete') await commit({ notes: '' });
  };

  const hasReview = saved.trim().length > 0;
  const when = hasReview ? formatDateLong(meta.notesUpdatedAt) : '';

  return (
    <section aria-label="La tua recensione" className="rounded-xl border border-black/[0.06] bg-ink-800 p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">La tua recensione</h3>

      {editing ? (
        <div>
          <textarea
            ref={area}
            value={draft}
            rows={5}
            maxLength={NOTES_MAX}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Esc annulla la modifica e non chiude la scheda.
              if (event.key === 'Escape') {
                event.stopPropagation();
                setEditing(false);
              }
            }}
            aria-label="Recensione"
            className="field-input resize-none overflow-hidden leading-relaxed"
          />
          {draft.length > COUNTER_FROM && (
            <p className="mt-1 text-right text-[11px] tabular-nums text-ink-500">
              {draft.length} / {NOTES_MAX}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary text-[13px]">
              Salva
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving} className="btn-ghost text-[13px]">
              Annulla
            </button>
          </div>
        </div>
      ) : hasReview ? (
        <div>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-200">{saved}</p>
          {when && <p className="mt-2 text-[11.5px] text-ink-500">Modificata il {when}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={start} className="btn-ghost text-[13px]">
              Modifica
            </button>
            <button type="button" onClick={() => void remove()} className="btn-subtle text-[12px] text-ink-400">
              Elimina
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p className="text-[13px] text-ink-400">Cosa ne pensi? Impressioni, citazioni, note per te.</p>
          <button type="button" onClick={start} className="btn-ghost mt-2 text-[13px]">
            Scrivi una recensione
          </button>
        </div>
      )}
    </section>
  );
}
