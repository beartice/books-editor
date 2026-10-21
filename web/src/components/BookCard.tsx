import { useStore } from '../store';
import { cn, formatDuration, formatRating, formatWords } from '../utils';
import BookCover from './BookCover';
import { IconHeart, IconStarFilled } from './icons';
import type { BookSummary } from '@shared/types';

export default function BookCard({ book }: { book: BookSummary }) {
  const select = useStore((state) => state.select);
  const selectedId = useStore((state) => state.selectedId);

  const seriesLabel =
    book.series && book.seriesIndex != null
      ? `${book.series} #${book.seriesIndex}`
      : book.series || '';

  return (
    <button
      onClick={() => select(book.id)}
      className={cn(
        'group relative flex w-full flex-col text-left transition active:scale-[0.98] active:opacity-80',
        selectedId === book.id && 'is-selected',
      )}
      aria-label={`Apri ${book.title || 'opera senza titolo'}`}
    >
      <div
        className={cn(
          'relative rounded-[14px] transition-transform duration-300 ease-out group-hover:-translate-y-1',
          selectedId === book.id && 'ring-2 ring-accent-500 ring-offset-4 ring-offset-white',
        )}
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
          className="aspect-[2/3] w-full shadow-book ring-1 ring-black/[0.08] transition-shadow duration-300 group-hover:shadow-[0_28px_48px_-20px_rgba(54,47,32,.42)]"
        />

        <div className="pointer-events-none absolute inset-0 rounded-[14px] bg-gradient-to-t from-ink-950/35 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

        {book.kind === 'fanfic' && (
          <span className="absolute left-2.5 top-2.5 rounded-full bg-white/90 px-2 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.12em] text-coral-600 shadow-sm backdrop-blur">
            fanfic
          </span>
        )}
        {book.favorite && (
          <span className="absolute right-2.5 top-2.5 rounded-full bg-white/90 p-1.5 text-coral-500 shadow-sm backdrop-blur">
            <IconHeart className="h-3 w-3" fill="currentColor" />
          </span>
        )}
        {book.rating != null && (
          <span className="absolute bottom-2.5 right-2.5 flex items-center gap-0.5 rounded-full bg-accent-900/85 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
            <IconStarFilled className="h-2.5 w-2.5" />
            {formatRating(book.rating)}
          </span>
        )}
      </div>

      {book.readingProgress != null && (
        <div
          className="mt-2 flex items-center gap-2 px-0.5"
          title={`Avanzamento di lettura: ${book.readingProgress}%`}
        >
          <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-accent-500 transition-[width] duration-300"
              style={{ width: `${Math.min(100, Math.max(0, book.readingProgress))}%` }}
            />
          </div>
          <span className="text-[9.5px] font-semibold tabular-nums text-accent-700">
            {book.readingProgress}%
          </span>
        </div>
      )}

      <div className="mt-3 min-w-0 px-0.5">
        <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug tracking-[-0.01em] text-ink-100 transition group-hover:text-accent-700">
          {book.title || 'Senza titolo'}
        </h3>
        <p className="mt-1 line-clamp-1 text-[11.5px] text-ink-500">
          {book.authors.join(', ') || 'Autore sconosciuto'}
        </p>
        {seriesLabel && (
          <p className="mt-0.5 line-clamp-1 text-[10.5px] italic text-ink-500/80">{seriesLabel}</p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-500">
          {book.fandom && (
            <span className="max-w-[9.5rem] truncate rounded-full bg-ink-800 px-2 py-0.5 text-ink-400">
              {book.fandom}
            </span>
          )}
          {book.fanRating && (
            <span className="rounded-full bg-ink-800 px-2 py-0.5 font-semibold text-ink-400">
              {book.fanRating}
            </span>
          )}
          {book.wordCount ? (
            <span className="ml-auto whitespace-nowrap tabular-nums">
              {formatWords(book.wordCount)} · {formatDuration(book.wordCount)}
            </span>
          ) : book.pageCount ? (
            <span className="ml-auto whitespace-nowrap tabular-nums">{book.pageCount} pag.</span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
