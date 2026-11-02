import { useEffect, useState } from 'react';
import type { BookMeta } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { formatDateLong } from '../utils';

/** Giorni di calendario da `from` a `to`, estremi compresi (stesso giorno = 1). */
function inclusiveDays(from: string, to: string): number | null {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day(end) - day(start)) / 86_400_000) + 1;
  return days >= 1 ? days : null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="shrink-0 text-[12px] text-ink-500 sm:w-44">{label}</dt>
      <dd className="min-w-0 break-words text-[13px] text-ink-200">{children}</dd>
    </div>
  );
}

/**
 * «Su Apple Books»: cio' che Libri sa del libro (stato, date, sottolineature) e i giorni di
 * lettura registrati. Solo informazioni: le azioni restano dove sono.
 */
export default function AppleBooksCard({ meta }: { meta: BookMeta }) {
  const setDetailTab = useStore((state) => state.setDetailTab);
  const [readingDays, setReadingDays] = useState<number | null>(null);
  const highlights = (meta.highlights ?? []).filter((item) => item.source === 'applebooks').length;
  const dates = meta.appleDates;
  const linked = Boolean(meta.identifiers?.applebooks);
  const visible = linked || Boolean(dates) || highlights > 0;

  // I giorni di lettura arrivano solo dalla risposta di GET /api/books/:id (le modifiche non li restituiscono).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setReadingDays(null);
    api
      .book(meta.id)
      .then((full) => {
        if (!cancelled) setReadingDays(full.readingDays ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [meta.id, visible]);

  if (!visible) return null;

  // Salvato da una versione vecchia: mancano ancora fine e avanzamento di Apple.
  const detailed = dates !== undefined && dates.finishedAt !== undefined;
  const progress = dates?.progress ?? 0;
  const lastOpened = dates?.lastOpenedAt || dates?.lastEngagedAt || '';
  const duration =
    dates?.firstOpenedAt && dates.finishedAt ? inclusiveDays(dates.firstOpenedAt, dates.finishedAt) : null;

  return (
    <section aria-label="Su Apple Books" className="rounded-xl border border-black/[0.06] bg-ink-800 p-3">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">Su Apple Books</h3>
      <dl className="divide-y divide-black/[0.05]">
        {detailed && (
          <Row label="Stato in Apple Books">
            {dates!.finishedAt
              ? `Finito il ${formatDateLong(dates!.finishedAt)}`
              : progress > 0
                ? `Letto al ${Math.round(progress)}%`
                : 'Non iniziato'}
          </Row>
        )}
        {dates?.addedAt && <Row label="Aggiunto a Libri">{formatDateLong(dates.addedAt)}</Row>}
        {dates?.firstOpenedAt && (
          <Row label="Prima apertura">
            {formatDateLong(dates.firstOpenedAt)}{' '}
            <span className="text-[11.5px] text-ink-500">stimata dalle sottolineature</span>
          </Row>
        )}
        {lastOpened && <Row label="Ultima apertura">{formatDateLong(lastOpened)}</Row>}
        {duration !== null && <Row label="Durata della lettura">Letto in {duration} {duration === 1 ? 'giorno' : 'giorni'}</Row>}
        {highlights > 0 && (
          <Row label="Sottolineature">
            {highlights} in Apple Books{' '}
            <button
              type="button"
              onClick={() => setDetailTab('highlights')}
              className="ml-1 min-h-9 text-[12.5px] font-semibold text-accent-600 hover:text-accent-500"
            >
              Vedi
            </button>
          </Row>
        )}
        {readingDays !== null && readingDays > 0 && (
          <Row label="Giorni di lettura registrati">{readingDays}</Row>
        )}
      </dl>
      {!detailed && linked && (
        <p className="mt-1 text-[11.5px] text-ink-500">
          I dettagli compaiono dopo la prossima sincronizzazione con Apple Books dall'app per Mac.
        </p>
      )}
    </section>
  );
}
