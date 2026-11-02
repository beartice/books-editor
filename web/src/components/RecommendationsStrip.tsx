import { useMemo } from 'react';
import type { BookRecommendation, BookSummary } from '@shared/types';
import { countActiveFilters, useStore } from '../store';
import { useRecommendations } from '../useRecommendations';
import BookCover from './BookCover';
import { IconAlert } from './icons';

/** Sezioni della striscia, in ordine di priorita': etichetta e numero massimo di schede. */
const SECTIONS = [
  { key: 'seriesNext', label: 'Seguito', max: 3 },
  { key: 'booksByAuthor', label: 'Stesso autore', max: 2 },
  { key: 'fanfics', label: 'Fanfic', max: 3 },
  { key: 'booksToExplore', label: 'Da esplorare', max: 2 },
] as const;

interface Item {
  entry: BookRecommendation;
  book: BookSummary;
  label: string;
}

/**
 * Striscia «Cosa leggere dopo» nella testata della home: poche schede prese a turno dalle
 * sezioni dei suggerimenti. Si vede solo senza ricerca ne' filtri, e solo se ci sono voci:
 * niente riquadri vuoti, niente avvisi in caso di errore.
 */
export default function RecommendationsStrip() {
  const query = useStore((state) => state.query);
  const filters = useStore((state) => state.filters);
  const books = useStore((state) => state.books);
  const setRecommendationsOpen = useStore((state) => state.setRecommendationsOpen);
  const shown = query.trim() === '' && countActiveFilters(filters) === 0;
  const { data } = useRecommendations(shown);

  const items = useMemo<Item[]>(() => {
    if (!data?.enough) return [];
    const byId = new Map(books.map((book) => [book.id, book]));
    const columns = SECTIONS.map((section) => ({
      label: section.label,
      entries: data[section.key].slice(0, section.max),
    }));
    const result: Item[] = [];
    const seen = new Set<string>();
    // A turno: una scheda per sezione, poi il secondo giro, fino a esaurire le voci.
    for (let round = 0; round < Math.max(...SECTIONS.map((section) => section.max)); round += 1) {
      for (const column of columns) {
        const entry = column.entries[round];
        const book = entry ? byId.get(entry.id) : undefined;
        if (!entry || !book || seen.has(entry.id)) continue;
        seen.add(entry.id);
        result.push({ entry, book, label: column.label });
      }
    }
    return result;
  }, [data, books]);

  if (!shown || items.length === 0 || !data) return null;

  const open = (id: string) => {
    void useStore.getState().select(id);
    useStore.getState().setDetailTab('details');
  };
  const { read, abandoned, favorites } = data.basedOn;

  return (
    <section aria-label="Cosa leggere dopo" className="mt-5 sm:mt-7">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="shrink-0 text-[18px] font-bold tracking-[-0.02em] text-ink-50 sm:text-[20px]">
            Cosa leggere dopo
          </h2>
          <p className="hidden min-w-0 truncate text-[12px] text-ink-500 sm:block">
            In base a {read} {read === 1 ? 'letto' : 'letti'}, {abandoned}{' '}
            {abandoned === 1 ? 'abbandonato' : 'abbandonati'} e {favorites}{' '}
            {favorites === 1 ? 'preferito' : 'preferiti'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRecommendationsOpen(true)}
          className="min-h-11 shrink-0 px-1 text-[12.5px] font-semibold text-accent-600 transition hover:text-accent-500"
        >
          <span className="hidden sm:inline">Vedi tutti i suggerimenti</span>
          <span className="sm:hidden">Tutti</span>
        </button>
      </div>

      <div className="no-scrollbar -mx-4 mt-1 flex items-start snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-3 sm:mx-0 sm:scroll-px-0 sm:gap-4 sm:px-0">
        {items.map(({ entry, book, label }) => {
          const reason = entry.reasons.find((item) => item.kind !== 'caution');
          const caution = entry.reasons.find((item) => item.kind === 'caution');
          return (
            <button
              key={book.id}
              type="button"
              onClick={() => open(book.id)}
              aria-label={`Apri ${book.title}`}
              className="group flex w-[132px] shrink-0 snap-start flex-col text-left sm:w-[156px]"
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
                className="h-[192px] w-full shadow-book ring-1 ring-black/[0.08] sm:h-[226px]"
              />
              <span className="mt-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em] text-accent-600 sm:text-[10.5px]">
                {label}
                {caution && (
                  <span title={caution.text} aria-label={caution.text} className="shrink-0 text-amber-600">
                    <IconAlert className="h-3 w-3" aria-hidden="true" />
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[13px] font-semibold text-ink-100">{book.title}</span>
              {reason && <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-300">{reason.text}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
