import { useStore } from '../store';
import { formatDate, formatDuration, formatRating, formatWords, cn } from '../utils';
import BookCover from './BookCover';
import { IconStarFilled } from './icons';
import type { BookSummary } from '@shared/types';

export default function BookList({ books }: { books: BookSummary[] }) {
  const select = useStore((state) => state.select);
  const selectedId = useStore((state) => state.selectedId);

  return (
    <div className="overflow-hidden rounded-[22px] border border-black/[0.06] bg-white shadow-soft">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-ink-800 text-[9.5px] uppercase tracking-[0.13em] text-ink-500">
            <th className="px-4 py-3 font-semibold">Titolo</th>
            <th className="hidden px-3 py-3 font-semibold md:table-cell">Autore</th>
            <th className="hidden px-3 py-3 font-semibold lg:table-cell">Serie</th>
            <th className="hidden px-3 py-3 font-semibold sm:table-cell">Lunghezza</th>
            <th className="hidden px-3 py-3 font-semibold lg:table-cell">Fandom</th>
            <th className="hidden px-3 py-3 font-semibold xl:table-cell">Aggiunto</th>
            <th className="px-4 py-3 text-right font-semibold">Voto</th>
          </tr>
        </thead>
        <tbody>
          {books.map((book) => (
            <tr
              key={book.id}
              onClick={() => select(book.id)}
              className={cn(
                'cursor-pointer border-t border-black/[0.05] text-[12.5px] transition hover:bg-ink-800/70 active:bg-ink-800',
                selectedId === book.id && 'bg-accent-500/[0.07]',
              )}
            >
              <td className="max-w-[22rem] px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <BookCover
                    id={book.id}
                    coverFile={book.coverFile}
                    title={book.title}
                    authors={book.authors}
                    kind={book.kind}
                    version={book.dateModified}
                    rounded="rounded-[4px]"
                    size="small"
                    className="h-11 w-[31px] shrink-0 shadow-sm ring-1 ring-black/[0.06]"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          book.kind === 'fanfic' ? 'bg-coral-500' : 'bg-accent-500',
                        )}
                      />
                      <span className="truncate font-semibold text-ink-100">
                        {book.title || 'Senza titolo'}
                      </span>
                      {book.favorite && <span className="text-coral-500">♥</span>}
                    </div>
                    <p className="mt-0.5 truncate text-[10.5px] text-ink-500 md:hidden">
                      {book.authors.join(', ') || 'Autore sconosciuto'}
                    </p>
                  </div>
                </div>
              </td>
              <td className="hidden max-w-[14rem] truncate px-3 py-2.5 text-ink-300 md:table-cell">
                {book.authors.join(', ') || '—'}
              </td>
              <td className="hidden max-w-[12rem] truncate px-3 py-2.5 text-ink-400 lg:table-cell">
                {book.series || '—'}
              </td>
              <td className="hidden whitespace-nowrap px-3 py-2.5 text-ink-400 sm:table-cell">
                {book.wordCount
                  ? `${formatWords(book.wordCount)} · ${formatDuration(book.wordCount)}`
                  : book.pageCount
                    ? `${book.pageCount} pag.`
                    : '—'}
              </td>
              <td className="hidden max-w-[12rem] truncate px-3 py-2.5 text-ink-400 lg:table-cell">
                {book.fandom || '—'}
              </td>
              <td className="hidden whitespace-nowrap px-3 py-2.5 text-ink-500 xl:table-cell">
                {formatDate(book.dateAdded)}
              </td>
              <td className="px-4 py-2.5 text-right">
                {book.rating != null ? (
                  <span className="inline-flex items-center gap-0.5 font-medium text-coral-600">
                    <IconStarFilled className="h-3 w-3" />
                    {formatRating(book.rating)}
                  </span>
                ) : (
                  <span className="text-ink-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
