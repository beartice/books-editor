import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { BookSummary } from '@shared/types';
import { useStore } from '../store';
import { bookGenres, unmappedTags } from '../genres';
import {
  bookLanguages,
  computeGenreStats,
  computeLanguages,
  computeTopFandoms,
  formatRating,
  ratedGenres,
} from '../stats';
import { BOOK_COLOR, EmptyNote, FANFIC_COLOR } from './StatsParts';
import { DataTable, DataToggle, Hit, useDataView } from './StatsUi';
import type { DataRow, ListSpec, TipContent } from './StatsUi';

// Sezione «Altro» del Cruscotto: le statistiche della vecchia finestra che non entrano nelle
// tre viste (voto medio per genere, fandom, lingue). Riguardano tutta la libreria, non il periodo.

const BAR_MAX = 24;

function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['it'], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Codice non riconosciuto: si mostra com'e'.
  }
  return code;
}

interface BarRow {
  key: string;
  name: string;
  value: number;
  /** Testo alla punta della barra. */
  valueLabel: string;
  tip: TipContent;
  list: ListSpec;
}

/** Barre orizzontali: nome a sinistra, valore alla punta. Una sola serie. */
function HBarChart({ rows, max }: { rows: BarRow[]; max?: number }) {
  const top = max ?? Math.max(...rows.map((row) => row.value), 0);
  return (
    <div className="stats-group flex flex-col gap-[2px]">
      {rows.map((row) => {
        const fraction = top > 0 ? row.value / top : 0;
        return (
          <Hit
            key={row.key}
            tip={row.tip}
            list={row.list}
            className="stats-item flex min-h-10 w-full items-center gap-2 rounded-md px-1 text-left hover:bg-ink-800 sm:h-7 sm:min-h-0"
          >
            <span className="w-28 shrink-0 truncate text-right text-[11.5px] text-ink-300 sm:w-36">{row.name}</span>
            <span className="flex min-w-0 flex-1 items-center">
              <span
                className="block rounded-r-[4px] bg-accent-500"
                style={{
                  height: Math.min(BAR_MAX, 16),
                  width: `max(2px, calc((100% - 7.5rem) * ${fraction}))`,
                }}
              />
              <span className="ml-2 whitespace-nowrap text-[11px] tabular-nums text-ink-200">{row.valueLabel}</span>
            </span>
          </Hit>
        );
      })}
    </div>
  );
}

/** Scheda con il suo «Mostra dati» (se ci sono dati): il contenuto sa se mostrare la tabella. */
function OtherCard({
  title,
  note,
  hasData,
  children,
}: {
  title: string;
  note: string;
  hasData: boolean;
  children: (table: boolean) => ReactNode;
}) {
  const [table, toggleTable] = useDataView();
  return (
    <section className="rounded-[18px] border border-[#ebe5d9] p-4 sm:p-[18px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[14.5px] font-semibold text-ink-100">{title}</h3>
          <p className="mt-0.5 text-xs text-[#6b655a]">{note}</p>
        </div>
        {hasData && <DataToggle table={table} onToggle={toggleTable} />}
      </div>
      <div className="mt-3">{children(table)}</div>
    </section>
  );
}

const idsOf = (books: BookSummary[], test: (book: BookSummary) => boolean) =>
  books.filter(test).map((book) => book.id);

/** Barre oppure tabella con le stesse righe. */
function BarsOrTable({
  table,
  caption,
  head,
  rows,
  cells,
  max,
}: {
  table: boolean;
  caption: string;
  head: string[];
  rows: BarRow[];
  cells: (row: BarRow) => (string | number)[];
  max?: number;
}) {
  if (!table) return <HBarChart rows={rows} max={max} />;
  const dataRows: DataRow[] = rows.map((row) => ({ key: row.key, label: row.name, cells: cells(row), list: row.list }));
  return <DataTable caption={caption} head={head} rows={dataRows} />;
}

export default function StatsOther({ hasFanfics }: { hasFanfics: boolean }) {
  const books = useStore((state) => state.books);
  const allGenres = useMemo(() => computeGenreStats(books), [books]);
  const ratedByGenre = useMemo(() => ratedGenres(allGenres), [allGenres]);
  const fandoms = useMemo(() => computeTopFandoms(books), [books]);
  const languages = useMemo(() => computeLanguages(books), [books]);
  const unmapped = useMemo(() => unmappedTags(books, 12), [books]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[17px] font-semibold text-ink-100">Altro</h2>
        <p className="mt-0.5 text-xs text-[#6b655a]">Su tutta la libreria, senza il filtro del periodo.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <OtherCard title="Voto medio per genere" note="Solo generi con almeno 3 libri votati" hasData={ratedByGenre.length > 0}>
          {(table) => (
            <>
            {ratedByGenre.length === 0 ? (
              <EmptyNote>Nessun genere ha ancora 3 libri votati.</EmptyNote>
            ) : (
              <BarsOrTable
                table={table}
                caption="Voto medio per genere"
                head={['Genere', 'Voto medio', 'Votati', 'Letti']}
                max={5}
                cells={(row) => {
                  const item = ratedByGenre.find((entry) => entry.genre === row.key)!;
                  return [formatRating(item.averageRating ?? 0), item.rated, item.read];
                }}
                rows={ratedByGenre.map((item) => ({
                  key: item.genre,
                  name: item.genre,
                  value: item.averageRating ?? 0,
                  valueLabel: formatRating(item.averageRating ?? 0),
                  tip: {
                    title: item.genre,
                    lines: [
                      { color: BOOK_COLOR, text: `voto medio ${formatRating(item.averageRating ?? 0)}` },
                      { text: `${item.rated} votati · ${item.read} letti` },
                    ],
                  },
                  list: {
                    title: `genere ${item.genre}`,
                    ids: idsOf(books, (book) => bookGenres(book.tags).includes(item.genre)),
                    date: 'none',
                    order: 'rating',
                  },
                }))}
              />
            )}
            {unmapped.length > 0 && (
              <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
                Tag non classificati più frequenti: {unmapped.map((item) => `${item.tag} (${item.count})`).join(', ')}
              </p>
            )}
            </>
          )}
        </OtherCard>

        {hasFanfics && (
          <OtherCard title="Fandom più presenti" note="Fanfic per fandom, primi 10" hasData={fandoms.length > 0}>
            {(table) => fandoms.length === 0 ? (
              <EmptyNote>Nessuna fanfic con fandom nella libreria.</EmptyNote>
            ) : (
              <BarsOrTable
                table={table}
                caption="Fandom più presenti"
                head={['Fandom', 'Fanfic']}
                cells={(row) => [row.value]}
                rows={fandoms.map((item) => ({
                  key: item.name,
                  name: item.name,
                  value: item.count,
                  valueLabel: String(item.count),
                  tip: { title: item.name, lines: [{ color: FANFIC_COLOR, text: `${item.count} fanfic` }] },
                  list: {
                    title: `fandom ${item.name}`,
                    ids: idsOf(books, (book) => book.kind === 'fanfic' && book.fandom?.trim() === item.name),
                    date: 'none',
                    filter: { kinds: ['fanfic'], fandoms: [item.name] },
                  },
                }))}
              />
            )}
          </OtherCard>
        )}

        <OtherCard title="Lingue" note="Libri per lingua, edizioni comprese" hasData={languages.length > 0}>
          {(table) => languages.length === 0 ? (
            <EmptyNote>Nessun libro con la lingua indicata.</EmptyNote>
          ) : (
            <BarsOrTable
              table={table}
              caption="Lingue"
              head={['Lingua', 'Libri']}
              cells={(row) => [row.value]}
              rows={languages.map((item) => ({
                key: item.name,
                name: languageName(item.name),
                value: item.count,
                valueLabel: String(item.count),
                tip: { title: languageName(item.name), lines: [{ color: BOOK_COLOR, text: `${item.count} libri` }] },
                list: {
                  title: `lingua ${languageName(item.name).toLowerCase()}`,
                  ids: idsOf(books, (book) => bookLanguages(book).includes(item.name)),
                  date: 'none',
                },
              }))}
            />
          )}
        </OtherCard>
      </div>
    </section>
  );
}
