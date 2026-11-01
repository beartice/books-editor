import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookRecommendation, BookSummary, RecommendationsResult } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import BookCover from './BookCover';
import { IconAlert, IconClose } from './icons';

interface Props {
  onClose: () => void;
}

type KindFilter = 'all' | 'book' | 'fanfic';

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'Tutti' },
  { id: 'book', label: 'Libri' },
  { id: 'fanfic', label: 'Fanfic' },
];

const sectionTitleClass = 'mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-500';

const pillClass = (active: boolean) =>
  `min-h-10 shrink-0 rounded-full px-4 text-[13px] transition ${
    active ? 'bg-accent-600 font-semibold text-white' : 'text-ink-200 hover:bg-black/[0.04]'
  }`;

/**
 * Carica i suggerimenti: li ricarica al cambio libreria, a ogni richiesta (`attempt`) e quando
 * si chiude la scheda di un libro (lo stato potrebbe essere cambiato). Durante la ricarica
 * l'elenco precedente resta visibile.
 */
function useRecommendations() {
  const libraryId = useStore((state) => state.libraryId);
  const selectedId = useStore((state) => state.selectedId);
  const [data, setData] = useState<RecommendationsResult | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const previousSelected = useRef(selectedId);

  useEffect(() => {
    if (previousSelected.current && !selectedId) setAttempt((value) => value + 1);
    previousSelected.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    api
      .recommendations()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((failure) => {
        if (!cancelled) setError((failure as Error).message || 'Impossibile leggere i suggerimenti');
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId, attempt]);

  // Cambio libreria: i suggerimenti dell'altra non servono piu'.
  useEffect(() => {
    setData(null);
  }, [libraryId]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { data, error, reload };
}

function authorsOf(book: BookSummary): string {
  return book.authors.join(', ') || 'Autore sconosciuto';
}

interface CardProps {
  entry: BookRecommendation;
  book: BookSummary;
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}

function RecommendationCard({ entry, book, onOpen, onDismiss }: CardProps) {
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-black/[0.06] bg-white p-3 sm:flex-row sm:items-start sm:gap-4 sm:p-4">
      <button
        type="button"
        onClick={() => onOpen(book.id)}
        className="flex min-w-0 flex-1 items-start gap-3 text-left sm:gap-4"
      >
        <BookCover
          id={book.id}
          coverFile={book.coverFile}
          title={book.title}
          authors={book.authors}
          kind={book.kind}
          version={book.dateModified}
          size="small"
          className="h-24 w-16 shrink-0 sm:h-28 sm:w-[72px]"
          rounded="rounded-md"
        />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[14px] font-semibold leading-snug text-ink-100">
            {book.title}
          </span>
          <span className="mt-0.5 block break-words text-[12px] text-ink-400">{authorsOf(book)}</span>
          <span className="mt-2 flex flex-col gap-1">
            {entry.reasons.map((reason, index) =>
              reason.kind === 'caution' ? (
                <span
                  key={index}
                  className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2 py-1 text-[12px] leading-snug text-amber-800"
                >
                  <IconAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-words">{reason.text}</span>
                </span>
              ) : (
                <span key={index} className="break-words text-[12.5px] leading-snug text-ink-300">
                  {reason.text}
                </span>
              ),
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDismiss(book.id)}
        className="btn-subtle min-h-10 shrink-0 self-end px-2.5 text-[12px] sm:self-start"
        aria-label={`Non mi interessa: ${book.title}`}
      >
        Non mi interessa
      </button>
    </li>
  );
}

/**
 * «Cosa leggere dopo» a schermo intero: suggerimenti fra i libri non letti della libreria,
 * con la motivazione di ciascuno. Ha una voce di cronologia propria, come le statistiche.
 */
export default function RecommendationsView({ onClose }: Props) {
  const books = useStore((state) => state.books);
  const { data, error, reload } = useRecommendations();
  const [filter, setFilter] = useState<KindFilter>('all');
  // Nascosti da poco: spariscono subito, prima che la ricarica confermi.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(books.map((book) => [book.id, book])), [books]);

  // Cronologia: una voce per la vista, cosi' «Indietro» la chiude senza uscire dall'app.
  useEffect(() => {
    if (!window.history.state?.recommendations) window.history.pushState({ recommendations: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onClose]);

  const close = useCallback(() => {
    if (window.history.state?.recommendations) window.history.back();
    else onClose();
  }, [onClose]);

  useEffect(() => {
    // Esc chiude la scheda dell'opera (se ne occupa il suo pannello), poi la vista.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (useStore.getState().selectedId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  // Il focus entra nella vista e torna a chi l'aveva alla chiusura.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  // Schermo bloccato sotto la vista: niente scroll della pagina sottostante.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const openBook = useCallback((id: string) => {
    // La scheda si apre sopra la vista, che resta sotto.
    void useStore.getState().select(id);
    useStore.getState().setDetailTab('details');
  }, []);

  const setDismissed = useCallback(
    async (id: string, dismissed: boolean) => {
      if (dismissed) setPending((previous) => new Set(previous).add(id));
      try {
        await api.dismissRecommendation(id, dismissed);
        // Ripristinato: non e' piu' fra i nascosti da poco (la ricarica lo rimette fra i suggerimenti).
        if (!dismissed) {
          setPending((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
        }
        reload();
      } catch (failure) {
        useStore.getState().toast((failure as Error).message || 'Operazione non riuscita', 'error');
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
      }
    },
    [reload],
  );

  // Voci con la scheda disponibile (la libreria potrebbe essere cambiata sotto di noi).
  const visible = useCallback(
    (entries: BookRecommendation[]) =>
      entries.filter((entry) => byId.has(entry.id) && !pending.has(entry.id)),
    [byId, pending],
  );
  const seriesNext = useMemo(() => (data ? visible(data.seriesNext) : []), [data, visible]);
  const booksByAuthor = useMemo(() => (data ? visible(data.booksByAuthor) : []), [data, visible]);
  const booksToExplore = useMemo(() => (data ? visible(data.booksToExplore) : []), [data, visible]);
  const fanfics = useMemo(() => (data ? visible(data.fanfics) : []), [data, visible]);

  const kinds = useMemo(() => {
    const found = new Set<string>();
    for (const entry of [...seriesNext, ...booksByAuthor, ...booksToExplore, ...fanfics]) found.add(byId.get(entry.id)!.kind);
    return found;
  }, [seriesNext, booksByAuthor, booksToExplore, fanfics, byId]);
  const showFilter = kinds.has('book') && kinds.has('fanfic');
  const activeFilter = showFilter ? filter : 'all';
  const byKind = (entries: BookRecommendation[]) =>
    activeFilter === 'all' ? entries : entries.filter((entry) => byId.get(entry.id)!.kind === activeFilter);
  const seriesShown = byKind(seriesNext);
  // Le sezioni sono per tipo: il filtro le mostra o le nasconde.
  const booksShown = activeFilter === 'fanfic' ? [] : booksByAuthor;
  const exploreShown = activeFilter === 'fanfic' ? [] : booksToExplore;
  const fanficsShown = activeFilter === 'book' ? [] : fanfics;

  // Ripristina: dopo la conferma del server il libro lascia l'elenco dei nascosti.
  const dismissed = data ? data.dismissed.filter((id) => byId.has(id) && !pending.has(id)) : [];
  // Gli appena nascosti compaiono nell'elenco subito, senza aspettare la ricarica.
  const hiddenIds = [...new Set([...dismissed, ...[...pending].filter((id) => byId.has(id))])];

  const renderList = (entries: BookRecommendation[]) => (
    <ul className="flex flex-col gap-3">
      {entries.map((entry) => (
        <RecommendationCard
          key={entry.id}
          entry={entry}
          book={byId.get(entry.id)!}
          onOpen={openBook}
          onDismiss={(id) => void setDismissed(id, true)}
        />
      ))}
    </ul>
  );

  const basedOn = data?.basedOn;
  const shownCount = seriesShown.length + booksShown.length + exploreShown.length + fanficsShown.length;
  const nothing = data?.enough && shownCount === 0;

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Cosa leggere dopo"
      className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-[#f4f0e7] outline-none"
    >
      <div className="shrink-0 border-b border-black/[0.05]">
        <div className="mx-auto flex w-full max-w-[860px] items-center gap-3 px-4 py-3 sm:px-6">
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink-100">Cosa leggere dopo</h2>
          <button onClick={close} className="btn-subtle h-10 w-10 shrink-0 px-0" aria-label="Chiudi suggerimenti">
            <IconClose />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        <div className="mx-auto w-full max-w-[860px] px-4 pb-20 pt-5 sm:px-6 sm:pt-8">
          {error && !data ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-ink-300">{error}</p>
              <button onClick={reload} className="btn-ghost min-h-10">
                Riprova
              </button>
            </div>
          ) : !data ? (
            <p className="py-10 text-center text-sm text-ink-400">Cerco i suggerimenti…</p>
          ) : (
            <>
              {error && (
                <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800">
                  <span className="min-w-0 flex-1 break-words">{error}</span>
                  <button onClick={reload} className="btn-ghost min-h-10">
                    Riprova
                  </button>
                </div>
              )}
              {basedOn && (
                <p className="text-[13px] text-ink-400">
                  Basato su {basedOn.read} {basedOn.read === 1 ? 'letto' : 'letti'}, {basedOn.abandoned}{' '}
                  {basedOn.abandoned === 1 ? 'abbandonato' : 'abbandonati'}, {basedOn.favorites}{' '}
                  {basedOn.favorites === 1 ? 'preferito' : 'preferiti'}
                </p>
              )}

              {!data.enough ? (
                <p className="mt-6 rounded-2xl border border-black/[0.06] bg-white p-5 text-sm text-ink-300">
                  Valuta almeno 5 libri per ricevere suggerimenti.
                </p>
              ) : (
                <>
                  {showFilter && (
                    <div role="group" aria-label="Tipo di opere" className="mt-4 flex w-fit gap-1.5 rounded-full border border-ink-700 bg-white p-1">
                      {FILTERS.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setFilter(item.id)}
                          aria-pressed={activeFilter === item.id}
                          className={pillClass(activeFilter === item.id)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {seriesShown.length > 0 && (
                    <section className="mt-6">
                      <h3 className={sectionTitleClass}>Continua una serie</h3>
                      {renderList(seriesShown)}
                    </section>
                  )}

                  {booksShown.length > 0 && (
                    <section className="mt-8">
                      <h3 className={sectionTitleClass}>Libri per te</h3>
                      {renderList(booksShown)}
                    </section>
                  )}

                  {exploreShown.length > 0 && (
                    <section className="mt-8">
                      <h3 className={sectionTitleClass}>Da esplorare</h3>
                      <p className="-mt-2 mb-3 text-[12.5px] text-ink-400">
                        Scelti solo per generi e trama: un'indicazione meno sicura, utile per scoprire qualcosa di diverso.
                      </p>
                      {renderList(exploreShown)}
                    </section>
                  )}

                  {fanficsShown.length > 0 && (
                    <section className="mt-8">
                      <h3 className={sectionTitleClass}>Fanfic per te</h3>
                      {renderList(fanficsShown)}
                    </section>
                  )}

                  {nothing && (
                    <p className="mt-6 rounded-2xl border border-black/[0.06] bg-white p-5 text-sm text-ink-300">
                      {seriesNext.length + booksByAuthor.length + booksToExplore.length + fanfics.length > 0
                        ? 'Nessun suggerimento di questo tipo: prova con un altro filtro.'
                        : 'Non ci sono libri da suggerire: tutto ciò che non hai letto è già in lettura, nascosto o troppo lontano dai tuoi gusti.'}
                    </p>
                  )}
                </>
              )}

              {hiddenIds.length > 0 && (
                <section className="mt-10 border-t border-black/[0.06] pt-4">
                  <button
                    type="button"
                    onClick={() => setShowDismissed((open) => !open)}
                    aria-expanded={showDismissed}
                    className="btn-subtle min-h-10 px-2 text-[13px]"
                  >
                    Nascosti ({hiddenIds.length})
                  </button>
                  {showDismissed && (
                    <ul className="mt-2 flex flex-col gap-2">
                      {hiddenIds.map((id) => {
                        const book = byId.get(id)!;
                        return (
                          <li
                            key={id}
                            className="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white px-3 py-2"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-[13px] font-medium text-ink-100">{book.title}</span>
                              <span className="block break-words text-[11.5px] text-ink-400">{authorsOf(book)}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => void setDismissed(id, false)}
                              className="btn-ghost min-h-10 shrink-0 text-[12px]"
                              aria-label={`Ripristina: ${book.title}`}
                            >
                              Ripristina
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
