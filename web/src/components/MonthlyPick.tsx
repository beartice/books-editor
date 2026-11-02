import { useId, useState } from 'react';
import { api } from '../api';
import { countActiveFilters, useStore } from '../store';
import { formatWords, monthName } from '../utils';
import { useMonthlyPick } from '../useMonthlyPick';
import BookCover from './BookCover';
import { IconDice } from './icons';

/** «circa 11 ore e mezza», «circa 25 minuti»: le ore si arrotondano alla mezz'ora. */
function approxTime(minutes: number): string {
  if (minutes < 60) return `circa ${Math.max(1, Math.round(minutes))} ${Math.round(minutes) === 1 ? 'minuto' : 'minuti'}`;
  const halves = Math.round(minutes / 30);
  const hours = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (hours === 0) return "circa mezz'ora";
  return `circa ${hours} ${hours === 1 ? 'ora' : 'ore'}${half ? ' e mezza' : ''}`;
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const actionClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-[13px] font-semibold transition';

/**
 * «Libro del mese» nella home: un libro non letto pescato a caso, con tempo di lettura stimato.
 * Compare solo senza ricerca ne' filtri e se c'e' un libro e la fascia non e' nascosta.
 */
export default function MonthlyPick() {
  const query = useStore((state) => state.query);
  const filters = useStore((state) => state.filters);
  const books = useStore((state) => state.books);
  const toast = useStore((state) => state.toast);
  const shown = query.trim() === '' && countActiveFilters(filters) === 0;
  const { data, setData } = useMonthlyPick(shown);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  const book = data?.book ? books.find((item) => item.id === data.book!.id) : undefined;
  if (!shown || !data || !data.book || data.hidden || !book) return null;

  const status = data.book.status;
  const month = monthName(data.month);
  const byId = new Map(books.map((item) => [item.id, item]));

  const run = async (task: () => Promise<typeof data>) => {
    setBusy(true);
    try {
      setData(await task());
    } catch (failure) {
      toast((failure as Error).message || 'Operazione non riuscita', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openBook = () => {
    void useStore.getState().select(book.id);
    useStore.getState().setDetailTab('details');
  };

  // Lettore integrato per EPUB e PDF; per gli altri formati si apre la scheda.
  const read = async () => {
    try {
      const meta = await api.book(book.id);
      if (meta.sourceFile && /\.(epub|pdf)$/i.test(meta.sourceFile)) {
        useStore.getState().openReader(book.id, meta.sourceFile);
        return;
      }
    } catch {
      // Scheda non leggibile: si apre il dettaglio.
    }
    openBook();
  };

  const pills = [
    book.wordCount ? formatWords(book.wordCount) : '',
    data.estimate && status !== 'finished' ? approxTime(data.estimate.minutes) : '',
    data.estimate && status !== 'finished' && data.estimate.perDay > 0
      ? `${approxTime(data.estimate.perDay)} al giorno`
      : '',
  ].filter(Boolean);

  return (
    <section
      aria-labelledby={titleId}
      className="mb-8 overflow-hidden rounded-[26px] bg-accent-900 p-4 text-white sm:p-6 lg:p-7"
    >
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="grid min-w-0 flex-1 grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-4 sm:grid-cols-[168px_minmax(0,1fr)] sm:gap-x-6">
          <button
            type="button"
            onClick={openBook}
            aria-label={`Apri ${book.title}`}
            className="self-start sm:row-span-2"
          >
            <BookCover
              id={book.id}
              coverFile={book.coverFile}
              title={book.title}
              authors={book.authors}
              kind={book.kind}
              version={book.dateModified}
              rounded="rounded-[14px]"
              size="thumb"
              className="h-[142px] w-[96px] shadow-book ring-1 ring-white/15 sm:h-[248px] sm:w-[168px]"
            />
          </button>

          <div className="min-w-0">
            <p id={titleId} className="text-[11px] font-bold uppercase tracking-[0.18em] text-accent-200">
              Il libro di {month}
            </p>
            <p className="mt-0.5 text-[11.5px] text-white/75">
              Pescato a caso fra i tuoi {data.poolSize} libri da leggere
            </p>
            <h2 className="mt-2 break-words text-[20px] font-bold leading-tight tracking-[-0.02em] sm:text-[28px]">
              {book.title}
            </h2>
            <p className="mt-1 break-words text-[13px] text-white/80">
              {book.authors.join(', ') || 'Autore sconosciuto'}
              {book.series
                ? ` · ${book.series}${book.seriesIndex !== null ? `, vol. ${book.seriesIndex}` : ''}`
                : ''}
            </p>
            {book.description && (
              <div className="mt-3 hidden max-w-2xl sm:block">
                <p className="line-clamp-3 text-[13px] leading-relaxed text-white/80">{book.description}</p>
              </div>
            )}
            {pills.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {pills.map((pill) => (
                  <li key={pill} className="rounded-full bg-white/[0.12] px-3 py-1 text-[12px] text-white/90">
                    {pill}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="col-span-2 flex flex-col gap-2 sm:col-span-1 sm:col-start-2 sm:flex-row sm:flex-wrap sm:self-end">
            {status === 'finished' ? (
              <span className={`${actionClass} bg-white/[0.12] text-white`}>Finito ✓</span>
            ) : (
              <button
                type="button"
                onClick={() => void read()}
                className={`${actionClass} bg-white text-accent-900 hover:bg-accent-50`}
              >
                {status === 'reading' ? 'Continua a leggere' : 'Inizia a leggere'}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.rerollMonthlyPick())}
              className={`${actionClass} border border-white/35 text-white hover:bg-white/10 disabled:opacity-60`}
            >
              <IconDice className="h-4 w-4" aria-hidden="true" />
              Pesca un altro
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.hideMonthlyPick(true))}
              className={`${actionClass} text-white/85 hover:bg-white/10 disabled:opacity-60`}
            >
              Non questo mese
            </button>
          </div>
        </div>

        <aside className="hidden w-[230px] shrink-0 border-l border-white/15 pl-6 lg:block">
          <p className="text-[56px] font-bold leading-none tracking-[-0.04em]">{data.daysLeft}</p>
          <p className="mt-1 text-[13px] text-white/80">
            {data.daysLeft === 1 ? 'giorno' : 'giorni'} alla fine di {month}
          </p>
          {data.history.length > 0 && (
            <>
              <p className="mt-6 text-[11px] font-bold uppercase tracking-[0.18em] text-accent-200">
                Mesi precedenti
              </p>
              <ul className="mt-2 flex flex-col gap-1.5 text-[12.5px] text-white/85">
                {data.history.map((entry) => {
                  const past = byId.get(entry.bookId);
                  return (
                    <li key={entry.month} className="break-words">
                      {capitalize(monthName(entry.month))}:{' '}
                      {past ? `${past.title}${entry.finished ? ' ✓' : ''}` : 'libro rimosso'}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
