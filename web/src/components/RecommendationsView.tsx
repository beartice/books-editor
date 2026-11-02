import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookRecommendation, BookSummary, TasteItem } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { useMonthlyPick } from '../useMonthlyPick';
import { useRecommendations } from '../useRecommendations';
import { formatWords, languageCode, languageLabel, monthName } from '../utils';
import BookCover from './BookCover';
import { IconAlert, IconClose, IconDice } from './icons';

interface Props {
  onClose: () => void;
}

/** La pagina chiede piu' voci del predefinito: i filtri ne scartano parecchie. */
const PAGE_LIMIT = 50;

type KindFilter = 'all' | 'book' | 'fanfic';
type LengthFilter = 'any' | 'short' | 'medium' | 'long';

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'Tutti' },
  { id: 'book', label: 'Libri' },
  { id: 'fanfic', label: 'Fanfic' },
];

const LENGTHS: { id: LengthFilter; label: string }[] = [
  { id: 'any', label: 'Qualsiasi' },
  { id: 'short', label: 'Breve (meno di 80k parole)' },
  { id: 'medium', label: 'Media (80–150k)' },
  { id: 'long', label: 'Lunga (oltre 150k)' },
];

/** Soglie delle fasce di lunghezza, in parole. */
const SHORT_MAX = 80_000;
const LONG_MIN = 150_000;

function matchesLength(book: BookSummary, length: LengthFilter): boolean {
  if (length === 'any') return true;
  const words = book.wordCount;
  if (!words || words <= 0) return false;
  if (length === 'short') return words < SHORT_MAX;
  if (length === 'long') return words > LONG_MIN;
  return words >= SHORT_MAX && words <= LONG_MIN;
}

const sectionTitleClass = 'text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-500';

const pillClass = (active: boolean) =>
  `min-h-10 shrink-0 rounded-full px-4 text-[13px] transition ${
    active ? 'bg-accent-600 font-semibold text-white' : 'text-ink-200 hover:bg-black/[0.04]'
  }`;

const selectClass =
  'min-h-10 rounded-full border border-ink-700 bg-white px-3 text-[13px] text-ink-200 outline-none focus:border-accent-500';

function authorsOf(book: BookSummary): string {
  return book.authors.join(', ') || 'Autore sconosciuto';
}

/** Riga grigia sotto la motivazione: «Vol. N · Serie», altrimenti la lunghezza. */
function metaOf(book: BookSummary): string {
  if (book.series) return `${book.seriesIndex !== null ? `Vol. ${book.seriesIndex} · ` : ''}${book.series}`;
  return book.wordCount ? formatWords(book.wordCount) : '';
}

interface CardProps {
  entry: BookRecommendation;
  book: BookSummary;
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}

function ShelfCard({ entry, book, onOpen, onDismiss }: CardProps) {
  const meta = metaOf(book);
  const firstReason = entry.reasons.find((reason) => reason.kind !== 'caution');
  const caution = entry.reasons.find((reason) => reason.kind === 'caution');
  return (
    <li className="relative w-[140px] shrink-0 snap-start sm:w-[176px]">
      <button
        type="button"
        onClick={() => onOpen(book.id)}
        aria-label={`Apri ${book.title}`}
        className="block w-full text-left"
      >
        <BookCover
          id={book.id}
          coverFile={book.coverFile}
          title={book.title}
          authors={book.authors}
          kind={book.kind}
          version={book.dateModified}
          size="thumb"
          rounded="rounded-[14px]"
          className="h-[204px] w-full shadow-book ring-1 ring-black/[0.08] sm:h-[256px]"
        />
        <span className="mt-2 block truncate text-[13px] font-semibold text-ink-100">{book.title}</span>
        <span className="mt-0.5 flex flex-col gap-1">
          {firstReason && (
            <span className="line-clamp-2 text-[12px] leading-snug text-ink-300">{firstReason.text}</span>
          )}
          {caution && (
            <span className="flex items-start gap-1 text-[11.5px] leading-snug text-amber-800">
              <IconAlert className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="line-clamp-2">{caution.text}</span>
            </span>
          )}
        </span>
        {meta && <span className="mt-1 block truncate text-[11.5px] text-ink-500">{meta}</span>}
      </button>
      <button
        type="button"
        onClick={() => onDismiss(book.id)}
        title="Non mi interessa"
        aria-label={`Non mi interessa: ${book.title}`}
        className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/65 text-white shadow-sm transition hover:bg-ink-950/85"
      >
        <IconClose className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  );
}

function Shelf({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h3 className={sectionTitleClass}>{title}</h3>
      {note && <p className="mt-1 text-[12.5px] text-ink-400">{note}</p>}
      <ul className="no-scrollbar -mx-4 mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 sm:mx-0 sm:scroll-px-0 sm:gap-4 sm:px-0">
        {children}
      </ul>
    </section>
  );
}

export default function RecommendationsView({ onClose }: Props) {
  const books = useStore((state) => state.books);
  const { data, error, reload } = useRecommendations(true, PAGE_LIMIT);
  const monthly = useMonthlyPick();
  const [filter, setFilter] = useState<KindFilter>('all');
  const [length, setLength] = useState<LengthFilter>('any');
  const [language, setLanguage] = useState('');
  // Nascosti da poco: spariscono subito, prima che la ricarica confermi.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  // Voce del gusto aperta (una sola alla volta).
  const [openTaste, setOpenTaste] = useState<string | null>(null);
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

  const showMonthly = async () => {
    try {
      monthly.setData(await api.hideMonthlyPick(false));
    } catch (failure) {
      useStore.getState().toast((failure as Error).message || 'Operazione non riuscita', 'error');
    }
  };

  // Voci con la scheda disponibile (la libreria potrebbe essere cambiata sotto di noi).
  const visible = useCallback(
    (entries: BookRecommendation[]) => entries.filter((entry) => byId.has(entry.id) && !pending.has(entry.id)),
    [byId, pending],
  );
  const seriesNext = useMemo(() => (data ? visible(data.seriesNext) : []), [data, visible]);
  const booksByAuthor = useMemo(() => (data ? visible(data.booksByAuthor) : []), [data, visible]);
  const booksToExplore = useMemo(() => (data ? visible(data.booksToExplore) : []), [data, visible]);
  const fanfics = useMemo(() => (data ? visible(data.fanfics) : []), [data, visible]);

  const { kinds, languages } = useMemo(() => {
    const foundKinds = new Set<string>();
    const foundLanguages = new Set<string>();
    for (const entry of [...seriesNext, ...booksByAuthor, ...booksToExplore, ...fanfics]) {
      const book = byId.get(entry.id)!;
      foundKinds.add(book.kind);
      const code = languageCode(book.language);
      if (code) foundLanguages.add(code);
    }
    return { kinds: foundKinds, languages: [...foundLanguages].sort() };
  }, [seriesNext, booksByAuthor, booksToExplore, fanfics, byId]);
  const showKindFilter = kinds.has('book') && kinds.has('fanfic');
  const showLanguage = languages.length >= 2;
  const activeFilter = showKindFilter ? filter : 'all';
  const activeLanguage = showLanguage && languages.includes(language) ? language : '';

  // Tipo, lunghezza e lingua: i libri senza dati restano solo con «Qualsiasi».
  const passes = (entry: BookRecommendation) => {
    const book = byId.get(entry.id)!;
    if (activeFilter !== 'all' && book.kind !== activeFilter) return false;
    if (!matchesLength(book, length)) return false;
    if (activeLanguage && languageCode(book.language) !== activeLanguage) return false;
    return true;
  };
  const seriesShown = seriesNext.filter(passes);
  const booksShown = booksByAuthor.filter(passes);
  const exploreShown = booksToExplore.filter(passes);
  const fanficsShown = fanfics.filter(passes);
  const allShown = [...seriesShown, ...booksShown, ...exploreShown, ...fanficsShown];

  const surprise = () => {
    if (!allShown.length) return;
    openBook(allShown[Math.floor(Math.random() * allShown.length)].id);
  };

  // Ripristina: dopo la conferma del server il libro lascia l'elenco dei nascosti.
  const dismissed = data ? data.dismissed.filter((id) => byId.has(id) && !pending.has(id)) : [];
  // Gli appena nascosti compaiono nell'elenco subito, senza aspettare la ricarica.
  const hiddenIds = [...new Set([...dismissed, ...[...pending].filter((id) => byId.has(id))])];

  const renderShelf = (title: string, entries: BookRecommendation[], note?: string) =>
    entries.length > 0 && (
      <Shelf title={title} note={note}>
        {entries.map((entry) => (
          <ShelfCard
            key={entry.id}
            entry={entry}
            book={byId.get(entry.id)!}
            onOpen={openBook}
            onDismiss={(id) => void setDismissed(id, true)}
          />
        ))}
      </Shelf>
    );

  const basedOn = data?.basedOn;
  const taste = data?.taste;
  const hasTaste = Boolean(taste && (taste.liked.length > 0 || taste.disliked.length > 0));

  /** Pillole del gusto: un tocco apre l'elenco dei libri che le hanno fatte pesare. */
  const renderPills = (group: string, items: TasteItem[], liked: boolean) =>
    items.map((item) => {
      const key = `${group}:${item.kind}:${item.label}`;
      const open = openTaste === key;
      return (
        <button
          key={key}
          type="button"
          aria-expanded={open}
          onClick={() => setOpenTaste(open ? null : key)}
          className={`min-h-9 max-w-full break-words rounded-full border px-3 py-1 text-left text-[12.5px] transition ${
            liked
              ? 'border-accent-200 bg-accent-50 text-accent-800 hover:bg-accent-100'
              : 'border-black/10 bg-ink-800 text-ink-300 hover:bg-ink-750'
          } ${open ? 'ring-2 ring-accent-500/40' : ''}`}
        >
          {item.label}
        </button>
      );
    });
  const tasteRows: { title: string; group: string; items: TasteItem[]; liked: boolean }[] = taste
    ? [
        { title: 'Autori', group: 'a', items: taste.liked.filter((item) => item.kind === 'author'), liked: true },
        { title: 'Generi e tag', group: 't', items: taste.liked.filter((item) => item.kind === 'tag'), liked: true },
        { title: 'Pesano contro', group: 'd', items: taste.disliked, liked: false },
      ].filter((row) => row.items.length > 0)
    : [];
  const openedTaste = taste
    ? [
        ...taste.liked.map((item) => ({ item, key: `${item.kind === 'author' ? 'a' : 't'}:${item.kind}:${item.label}` })),
        ...taste.disliked.map((item) => ({ item, key: `d:${item.kind}:${item.label}` })),
      ].find((entry) => entry.key === openTaste)
    : undefined;

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
        <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3 px-4 py-3 sm:px-6">
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink-100">Cosa leggere dopo</h2>
          <button onClick={close} className="btn-subtle h-10 w-10 shrink-0 px-0" aria-label="Chiudi suggerimenti">
            <IconClose />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        <div className="mx-auto w-full max-w-[1100px] px-4 pb-20 pt-5 sm:px-6 sm:pt-8">
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

              {monthly.data?.hidden && monthly.data.book && (
                <p className="mb-4 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-400">
                  Libro di {monthName(monthly.data.month)} nascosto ·
                  <button type="button" onClick={() => void showMonthly()} className="min-h-10 font-semibold text-accent-600 hover:text-accent-500">
                    Mostra
                  </button>
                </p>
              )}

              {!data.enough ? (
                <p className="rounded-2xl border border-black/[0.06] bg-white p-5 text-sm text-ink-300">
                  Valuta almeno 5 libri per ricevere suggerimenti.
                </p>
              ) : (
                <>
                  {hasTaste && basedOn && (
                    <section aria-labelledby="taste-title" className="rounded-[22px] bg-white p-4 shadow-soft sm:p-6">
                      <div className="flex flex-col gap-4 lg:flex-row lg:gap-8">
                        <div className="lg:w-[300px] lg:shrink-0">
                          <p className="eyebrow text-ink-500">Il tuo gusto</p>
                          <h3 id="taste-title" className="mt-1 text-[18px] font-semibold tracking-[-0.02em] text-ink-50">
                            Cosa pesa nei suggerimenti
                          </h3>
                          <p className="mt-1 text-[12.5px] text-ink-400">
                            Calcolato da {basedOn.read} {basedOn.read === 1 ? 'letto' : 'letti'}, {basedOn.abandoned}{' '}
                            {basedOn.abandoned === 1 ? 'abbandonato' : 'abbandonati'} e {basedOn.favorites}{' '}
                            {basedOn.favorites === 1 ? 'preferito' : 'preferiti'}
                          </p>
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-3">
                          {tasteRows.map((row) => (
                            <div key={row.group} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
                              <span className="w-28 shrink-0 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                                {row.title}
                              </span>
                              <div className="flex min-w-0 flex-wrap gap-1.5">{renderPills(row.group, row.items, row.liked)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </section>
                  )}

                  {openedTaste && (
                    <section className="mt-3 rounded-2xl border border-black/[0.06] bg-white p-3 sm:p-4">
                      <p className="text-[12px] font-semibold text-ink-300">
                        {openedTaste.item.kind === 'length' ? 'Libri abbandonati' : 'Libri che pesano'}: {openedTaste.item.label}
                      </p>
                      <ul className="mt-2 flex flex-col">
                        {openedTaste.item.bookIds
                          .filter((id) => byId.has(id))
                          .map((id) => {
                            const book = byId.get(id)!;
                            return (
                              <li key={id}>
                                <button
                                  type="button"
                                  onClick={() => openBook(id)}
                                  className="flex min-h-11 w-full flex-col items-start justify-center rounded-lg px-2 text-left hover:bg-black/[0.03]"
                                >
                                  <span className="max-w-full truncate text-[13px] font-medium text-ink-100">{book.title}</span>
                                  <span className="max-w-full truncate text-[11.5px] text-ink-400">{authorsOf(book)}</span>
                                </button>
                              </li>
                            );
                          })}
                      </ul>
                    </section>
                  )}

                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    {showKindFilter && (
                      <div role="group" aria-label="Tipo di opere" className="flex gap-1.5 rounded-full border border-ink-700 bg-white p-1">
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
                    <label className="flex items-center gap-2 text-[12px] text-ink-400">
                      Lunghezza
                      <select value={length} onChange={(event) => setLength(event.target.value as LengthFilter)} className={selectClass}>
                        {LENGTHS.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {showLanguage && (
                      <label className="flex items-center gap-2 text-[12px] text-ink-400">
                        Lingua
                        <select value={activeLanguage} onChange={(event) => setLanguage(event.target.value)} className={selectClass}>
                          <option value="">Qualsiasi</option>
                          {languages.map((code) => (
                            <option key={code} value={code}>
                              {languageLabel(code)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={surprise}
                      disabled={allShown.length === 0}
                      className="btn-primary ml-auto min-h-10 disabled:opacity-50"
                    >
                      <IconDice className="h-4 w-4" aria-hidden="true" />
                      Sorprendimi
                    </button>
                  </div>

                  {renderShelf('Continua una serie', seriesShown)}
                  {renderShelf('Libri per te', booksShown)}
                  {renderShelf(
                    'Da esplorare',
                    exploreShown,
                    "Scelti solo per generi e trama: un'indicazione meno sicura, utile per scoprire qualcosa di diverso.",
                  )}
                  {renderShelf('Fanfic per te', fanficsShown)}

                  {allShown.length === 0 && (
                    <p className="mt-6 rounded-2xl border border-black/[0.06] bg-white p-5 text-sm text-ink-300">
                      {seriesNext.length + booksByAuthor.length + booksToExplore.length + fanfics.length > 0
                        ? 'Nessun suggerimento con questi filtri'
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
