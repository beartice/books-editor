import { cn } from '../utils';
import { IconChevron } from './icons';

interface Props {
  /** Pagina corrente, a partire da 1. */
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}

/**
 * Elenco dei numeri di pagina da mostrare: prima, ultima, corrente e le due
 * adiacenti; i salti diventano 'gap', tranne quando saltano una sola pagina.
 */
export function pageItems(page: number, pageCount: number): Array<number | 'gap'> {
  const wanted = new Set<number>();
  for (const n of [1, pageCount, page - 1, page, page + 1]) {
    if (n >= 1 && n <= pageCount) wanted.add(n);
  }
  const sorted = [...wanted].sort((a, b) => a - b);
  const items: Array<number | 'gap'> = [];
  sorted.forEach((n, index) => {
    if (index > 0) {
      const prev = sorted[index - 1];
      if (n - prev === 2) items.push(prev + 1);
      else if (n - prev > 2) items.push('gap');
    }
    items.push(n);
  });
  return items;
}

export default function Pagination({ page, pageCount, total, pageSize, onChange }: Props) {
  if (pageCount <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagine della libreria"
      className="mt-10 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-ink-500">
        {from}–{to} di {total}
      </p>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
          className="btn-ghost disabled:opacity-40"
        >
          <IconChevron className="h-4 w-4 rotate-180" />
          Precedente
        </button>

        <span className="px-2 text-sm text-ink-400 sm:hidden">
          {page} / {pageCount}
        </span>

        <div className="hidden items-center gap-1 sm:flex">
          {pageItems(page, pageCount).map((item, index) =>
            item === 'gap' ? (
              <span key={`gap-${index}`} className="px-1 text-sm text-ink-500">
                …
              </span>
            ) : (
              <button
                key={item}
                onClick={() => onChange(item)}
                aria-current={item === page ? 'page' : undefined}
                className={cn(
                  'h-9 min-w-9 rounded-full px-2 text-sm font-medium transition',
                  item === page
                    ? 'bg-accent-600 text-white'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
                )}
              >
                {item}
              </button>
            ),
          )}
        </div>

        <button
          onClick={() => onChange(page + 1)}
          disabled={page >= pageCount}
          className="btn-ghost disabled:opacity-40"
        >
          Successiva
          <IconChevron className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );
}
