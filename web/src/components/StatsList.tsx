import { useEffect, useMemo, useRef } from 'react';
import type { BookSummary } from '@shared/types';
import { useStore } from '../store';
import { formatRating } from '../stats';
import BookCover from './BookCover';
import { IconClose } from './icons';
import { formatDaySlash, plural } from './StatsParts';
import type { ListSpec } from './StatsUi';

// Pannello con l'elenco delle opere dietro un numero delle statistiche: laterale su desktop,
// foglio dal basso su telefono. Esc lo chiude (se ne occupa StatsView).

function dayOf(value: string | null | undefined): string {
  const match = value ? /^\d{4}-\d{2}-\d{2}/.exec(value) : null;
  return match ? match[0] : '';
}

const DATE_LABEL = { finished: 'Finito il', started: 'Iniziato il', added: 'Aggiunto il' } as const;

function dateOf(book: BookSummary, kind: 'finished' | 'started' | 'added'): string {
  if (kind === 'finished') return dayOf(book.dateFinished);
  if (kind === 'started') return dayOf(book.dateStarted);
  return dayOf(book.dateAdded);
}

interface Props {
  spec: ListSpec;
  onClose: () => void;
  onOpenBook: (id: string, tab?: 'highlights') => void;
  onShowInLibrary: () => void;
}

export default function StatsList({ spec, onClose, onOpenBook, onShowInLibrary }: Props) {
  const books = useStore((state) => state.books);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Il focus passa al pannello e al ritorno va a chi l'aveva (la tastiera riparte da li').
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  const rows = useMemo(() => {
    const byId = new Map(books.map((book) => [book.id, book]));
    const found = spec.ids.map((id) => byId.get(id)).filter((book): book is BookSummary => Boolean(book));
    const dateKind = spec.date && spec.date !== 'none' ? spec.date : null;
    const order = spec.order ?? (dateKind ? 'date' : 'title');
    const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
    if (order === 'given') return found;
    return [...found].sort((a, b) => {
      if (order === 'date' && dateKind) {
        const left = dateOf(a, dateKind);
        const right = dateOf(b, dateKind);
        // Senza data in fondo; poi dalla piu' recente.
        if (left !== right) return !left ? 1 : !right ? -1 : right.localeCompare(left);
      }
      if (order === 'rating') {
        const diff = (b.rating ?? -1) - (a.rating ?? -1);
        if (diff) return diff;
      }
      return collator.compare(a.title, b.title);
    });
  }, [books, spec]);

  const dateKind = spec.date && spec.date !== 'none' ? spec.date : null;

  return (
    <div className="fixed inset-0 z-20">
      <div className="absolute inset-0 bg-ink-950/25 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={`Opere: ${spec.title}`}
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] animate-slide-up flex-col rounded-t-3xl border-t border-black/[0.07] bg-white shadow-panel sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[440px] sm:animate-slide-in sm:rounded-none sm:border-l sm:border-t-0"
      >
        <header className="flex items-start gap-3 border-b border-black/[0.06] p-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-snug text-ink-50">Opere: {spec.title}</h2>
            <p className="mt-0.5 text-[13px] text-ink-300">{plural(rows.length, 'opera', 'opere')}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="btn-subtle h-10 w-10 shrink-0 px-0"
            aria-label="Chiudi l'elenco"
          >
            <IconClose />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          {rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-ink-400">Nessuna opera da mostrare.</p>
          ) : (
            <ul>
              {rows.map((book) => {
                const date = dateKind ? dateOf(book, dateKind) : '';
                const marks = spec.highlights?.[book.id] ?? 0;
                const note = [
                  marks > 0 ? plural(marks, 'sottolineatura', 'sottolineature') : '',
                  spec.notes?.[book.id] ?? '',
                ]
                  .filter(Boolean)
                  .join(' · ');
                const tab = spec.tab ?? (marks > 0 ? 'highlights' : undefined);
                return (
                  <li key={book.id}>
                    <button
                      type="button"
                      onClick={() => onOpenBook(book.id, tab)}
                      className="flex min-h-[68px] w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-ink-800 focus-visible:bg-ink-800"
                    >
                      <BookCover
                        id={book.id}
                        coverFile={book.coverFile}
                        title={book.title}
                        authors={book.authors}
                        kind={book.kind}
                        version={book.dateModified}
                        size="small"
                        className="h-14 w-10 shrink-0"
                        rounded="rounded-md"
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="line-clamp-2 text-sm font-semibold leading-snug text-ink-50">
                          {book.title || 'Senza titolo'}
                        </span>
                        <span className="truncate text-[12.5px] text-ink-300">
                          {book.authors.join(', ') || 'Autore sconosciuto'}
                        </span>
                        <span className="flex flex-wrap gap-x-2 text-[12px] text-ink-400">
                          {book.rating ? <span>{formatRating(book.rating)} ★</span> : null}
                          {dateKind && date ? (
                            <span>
                              {DATE_LABEL[dateKind]} {formatDaySlash(date)}
                            </span>
                          ) : null}
                          {note ? <span>{note}</span> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="border-t border-black/[0.06] p-3">
          <button type="button" onClick={onShowInLibrary} disabled={rows.length === 0} className="btn-primary min-h-11 w-full">
            Mostra nella libreria
          </button>
        </footer>
      </aside>
    </div>
  );
}
