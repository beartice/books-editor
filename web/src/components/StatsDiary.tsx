import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ReadingStats, ReadingStatsRead } from '@shared/types';
import {
  BOOK_COLOR,
  EmptyNote,
  FANFIC_COLOR,
  HeatCalendar,
  HeatLegend,
  KindLegend,
  MONTHS_SHORT,
  addDays,
  dayTime,
  daySpec,
  formatDaySlash,
  formatDaysValue,
  formatHours,
  formatRating,
  formatReadDays,
  formatWordsLong,
  numberFormat,
  plural,
} from './StatsParts';
import { DataTable, DataToggle, Hit, useDataView } from './StatsUi';
import type { DataRow, ListSpec } from './StatsUi';

const READ_STATUSES = ['read', 'reread'];

// Vista A «Diario»: totali, letture per anno, linea del tempo, calendario, autori.

const CARD = 'rounded-3xl border border-[#ebe5d9] bg-white p-4 sm:p-6';
const TIMELINE_LIMIT = 13;

function Tile({
  label,
  value,
  hint,
  list,
  className = '',
}: {
  label: string;
  value: string;
  hint: string;
  list?: ListSpec;
  className?: string;
}) {
  return (
    <Hit
      tip={{ title: `${label}: ${value}`, lines: [{ text: hint }] }}
      list={list}
      className={`flex flex-col gap-0.5 rounded-[18px] border border-[#ebe5d9] bg-white px-4 py-3.5 text-left sm:gap-1.5 sm:rounded-[20px] sm:px-[22px] sm:py-5 ${className}`}
    >
      <span className="text-[12px] font-semibold text-[#6b655a]">{label}</span>
      <span className="text-[26px] font-semibold tracking-[-0.02em] text-ink-100 sm:text-[34px]">{value}</span>
      <span className="text-[12px] text-[#6b655a] sm:text-[12.5px]">{hint}</span>
    </Hit>
  );
}

function CardTitle({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink-100 sm:text-[17px]">{title}</h2>
        {note && <p className="mt-1 text-[12.5px] text-[#6b655a]">{note}</p>}
      </div>
      {right}
    </div>
  );
}

/** Letture per anno: colonne impilate libri/fanfiction con il totale sopra. */
function YearsChart({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const [table, toggleTable] = useDataView();
  const max = Math.max(...stats.byYear.map((item) => item.books + item.fanfics), 1);
  const plot = 170;
  const yearList = (item: ReadingStats['byYear'][number], kind?: 'book' | 'fanfic'): ListSpec => ({
    title:
      kind === 'book'
        ? `libri letti nel ${item.year}`
        : kind === 'fanfic'
          ? `fanfiction lette nel ${item.year}`
          : `letture del ${item.year}`,
    ids: kind === 'book' ? item.bookIds : kind === 'fanfic' ? item.fanficIds : [...item.bookIds, ...item.fanficIds],
    date: 'finished',
  });
  const yearTip = (item: ReadingStats['byYear'][number]) => {
    const total = item.books + item.fanfics;
    const pct = stats.withFinishDate ? Math.round((total / stats.withFinishDate) * 100) : 0;
    return {
      title: `${item.year} · ${plural(total, 'lettura', 'letture')}`,
      lines: [
        { color: BOOK_COLOR, text: plural(item.books, 'libro', 'libri') },
        ...(stats.hasFanfics ? [{ color: FANFIC_COLOR, text: plural(item.fanfics, 'fanfiction', 'fanfiction') }] : []),
        { text: `${pct}% delle letture con data` },
      ],
    };
  };
  const rows: DataRow[] = stats.byYear.map((item) => ({
    key: String(item.year),
    label: String(item.year),
    cells: [
      item.books,
      ...(stats.hasFanfics ? [item.fanfics] : []),
      item.books + item.fanfics,
    ],
    list: yearList(item),
  }));
  return (
    <div className={`${CARD} flex flex-col gap-4 lg:col-span-7`}>
      <CardTitle
        title="Letture per anno"
        note={`Con data di fine: ${numberFormat.format(stats.withFinishDate)} delle ${numberFormat.format(stats.readTotal)} opere lette`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            {!table && <KindLegend hasFanfics={stats.hasFanfics} />}
            {stats.byYear.length > 0 && <DataToggle table={table} onToggle={toggleTable} />}
          </div>
        }
      />
      {stats.byYear.length === 0 ? (
        <EmptyNote>
          Nessuna opera letta ha una data di fine: le date arrivano da Apple Books oppure si inseriscono in «Finito il»
          nella scheda.
        </EmptyNote>
      ) : table ? (
        <DataTable
          caption="Letture per anno"
          head={['Anno', 'Libri', ...(stats.hasFanfics ? ['Fanfiction'] : []), 'Totale']}
          rows={rows}
        />
      ) : (
        <div className="overflow-x-auto">
          <div className="stats-group grid" style={{ minWidth: stats.byYear.length * 44, gridTemplateColumns: `repeat(${stats.byYear.length}, minmax(0, 1fr))` }}>
            {stats.byYear.map((item) => {
              const total = item.books + item.fanfics;
              const dim = selected !== 'all' && selected !== item.year;
              return (
                <div key={item.year} className={`stats-item flex flex-col ${dim ? 'opacity-40' : ''}`}>
                  <div
                    className="flex flex-col items-center justify-end gap-1.5 border-b border-ink-700 px-1 pt-2 sm:px-[9px]"
                    style={{ height: plot + 40 }}
                  >
                    <span className="text-[13px] font-semibold text-ink-100">{total}</span>
                    <div className="flex w-full max-w-16 flex-col gap-[2px]">
                      {item.fanfics > 0 && (
                        <Hit
                          data-kind="fanfic"
                          tip={yearTip(item)}
                          list={yearList(item, 'fanfic')}
                          label={`${item.year}: ${plural(item.fanfics, 'fanfiction', 'fanfiction')}`}
                          className="block rounded-t-[4px]"
                          style={{ height: (item.fanfics / max) * plot, background: FANFIC_COLOR }}
                        />
                      )}
                      {item.books > 0 && (
                        <Hit
                          data-kind="book"
                          tip={yearTip(item)}
                          list={yearList(item, 'book')}
                          label={`${item.year}: ${plural(item.books, 'libro', 'libri')}`}
                          className="block rounded-t-[4px]"
                          style={{ height: (item.books / max) * plot, background: BOOK_COLOR }}
                        />
                      )}
                    </div>
                  </div>
                  <Hit
                    tip={yearTip(item)}
                    list={yearList(item)}
                    label={`${item.year}: ${plural(total, 'lettura', 'letture')}`}
                    className="mt-1 min-h-10 rounded-lg text-center text-[12.5px] text-ink-300"
                  >
                    {item.year}
                  </Hit>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** «Dove sono le tue opere»: barre per stato, in proporzione al piu' numeroso. */
function StatusCard({ stats }: { stats: ReadingStats }) {
  const [table, toggleTable] = useDataView();
  const { tiles } = stats;
  const rows = [
    { label: 'Letti', count: tiles.read.total, ids: stats.ids.read, filter: { readingStatus: READ_STATUSES } },
    { label: 'In lettura', count: tiles.reading.total, ids: stats.ids.reading, filter: { readingStatus: ['reading'] } },
    { label: 'Abbandonati', count: tiles.dnf.total, ids: stats.ids.dnf, filter: { readingStatus: ['dnf'] } },
    { label: 'Da leggere', count: tiles.unread.total, ids: stats.ids.unread, filter: { readingStatus: ['unread'] } },
  ];
  const max = Math.max(...rows.map((row) => row.count), 1);
  const total = tiles.total.total;
  const pctOf = (count: number) => (total ? Math.round((count / total) * 100) : 0);
  const listOf = (row: (typeof rows)[number]): ListSpec => ({
    title: row.label.toLowerCase(),
    ids: row.ids,
    date: row.label === 'Letti' ? 'finished' : 'none',
    filter: row.filter,
  });
  return (
    <div className={`${CARD} flex flex-col gap-3.5 lg:col-span-5`}>
      <CardTitle
        title="Dove sono le tue opere"
        note={`${plural(total, 'opera', 'opere')} in libreria`}
        right={<DataToggle table={table} onToggle={toggleTable} />}
      />
      {table ? (
        <DataTable
          caption="Opere per stato"
          head={['Stato', 'Opere', '%']}
          rows={rows.map((row) => ({
            key: row.label,
            label: row.label,
            cells: [row.count, `${pctOf(row.count)}%`],
            list: listOf(row),
          }))}
        />
      ) : (
        <div className="stats-group flex flex-col gap-1">
          {rows.map((row) => (
            <Hit
              key={row.label}
              tip={{
                title: `${row.label} · ${plural(row.count, 'opera', 'opere')}`,
                lines: [{ text: `${pctOf(row.count)}% della libreria` }],
              }}
              list={listOf(row)}
              className="stats-item flex min-h-10 w-full flex-col justify-center gap-1.5 rounded-lg px-1 text-left"
            >
              <span className="flex justify-between text-[13.5px]">
                <span className="text-ink-100">{row.label}</span>
                <span className="font-semibold text-ink-200">
                  {numberFormat.format(row.count)}{' '}
                  <span className="font-normal text-[#6b655a]">· {pctOf(row.count)}%</span>
                </span>
              </span>
              <span className="block h-2.5 rounded-full bg-ink-750">
                <span
                  className="block h-full rounded-full bg-accent-600"
                  style={{ width: `${(row.count / max) * 100}%`, minWidth: row.count ? 6 : 0 }}
                />
              </span>
            </Hit>
          ))}
        </div>
      )}
    </div>
  );
}

/** Posizione (0-1) di un giorno nella finestra; la fine e' compresa. */
function makePosition(from: string, to: string) {
  const start = dayTime(from);
  const span = dayTime(to) + 86400000 - start;
  return (day: string) => Math.max(0, Math.min(1, (dayTime(day) - start) / span));
}

function Timeline({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const [all, setAll] = useState(false);
  const [table, toggleTable] = useDataView();
  const { items, medianDays } = stats.reads;
  const { from, to } = stats.window;
  const position = makePosition(from, to);
  const title = selected === 'all' ? 'Gli ultimi 12 mesi, lettura per lettura' : `Il ${selected}, lettura per lettura`;
  const shown = all ? items : items.slice(-TIMELINE_LIMIT);
  const spansYears = from.slice(0, 4) !== to.slice(0, 4);

  // Un'etichetta per mese; sul telefono una ogni tre.
  const months: { label: string; left: number; quarter: boolean }[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  let index = 0;
  while (`${year}-${String(month).padStart(2, '0')}` <= to.slice(0, 7)) {
    const first = `${year}-${String(month).padStart(2, '0')}-01`;
    months.push({
      label: MONTHS_SHORT[month - 1] + (spansYears && (month === 1 || index === 0) ? ` ’${String(year).slice(2)}` : ''),
      left: position(first < from ? from : first),
      quarter: index % 3 === 0,
    });
    index += 1;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  const axis = (extra: string) => (
    <div className={`relative h-[18px] text-[11.5px] text-[#6b655a] ${extra}`}>
      {months.map((item) => (
        <span
          key={item.label}
          className={`absolute top-0 ${item.quarter ? '' : 'max-sm:hidden'}`}
          style={{ left: `${item.left * 100}%` }}
        >
          {item.label}
        </span>
      ))}
    </div>
  );

  return (
    <div className={`${CARD} flex flex-col gap-3.5`}>
      <CardTitle
        title={title}
        note={`Da quando l'hai iniziata (stima da Apple Books) a quando l'hai finita${
          medianDays === null ? '' : ` · mediana ${medianDays === 0 ? 'stesso giorno' : formatDaysValue(medianDays)}`
        }`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            {!table && <KindLegend hasFanfics={stats.hasFanfics} />}
            {items.length > 0 && <DataToggle table={table} onToggle={toggleTable} />}
          </div>
        }
      />
      {items.length === 0 ? (
        <EmptyNote>
          {selected === 'all'
            ? 'Nessuna lettura con data di fine negli ultimi 12 mesi.'
            : `Nessuna lettura finita nel ${selected}.`}
        </EmptyNote>
      ) : table ? (
        <DataTable
          caption={title}
          head={['Titolo', 'Inizio', 'Fine', 'Durata']}
          tall
          rows={items.map((read) => ({
            key: read.id,
            label: read.title,
            cells: [
              read.start ? formatDaySlash(read.start) : '—',
              formatDaySlash(read.end),
              formatReadDays(read.days),
            ],
            book: { id: read.id },
          }))}
        />
      ) : (
        <>
          <div className="grid grid-cols-[240px_minmax(0,1fr)_96px] gap-x-3.5 max-sm:hidden">
            <span />
            {axis('')}
            <span />
          </div>
          <div className="stats-group flex flex-col-reverse gap-3.5 sm:flex-col sm:gap-0">
            {shown.map((read) => (
              <TimelineRow key={read.id} read={read} from={from} position={position} />
            ))}
          </div>
          <div className="sm:hidden">{axis('')}</div>
          {items.length > TIMELINE_LIMIT && (
            <button
              type="button"
              onClick={() => setAll((value) => !value)}
              className="min-h-10 self-start rounded-full border border-ink-700 bg-white px-3.5 text-[13px] font-semibold text-accent-600"
            >
              {all ? 'Mostra solo le ultime' : `Mostra tutte e ${items.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function TimelineRow({
  read,
  from,
  position,
}: {
  read: ReadingStatsRead;
  from: string;
  position: (day: string) => number;
}) {
  const startsBefore = read.start !== null && read.start < from;
  const left = position(read.start ?? read.end);
  // Il giorno di fine e' compreso: la barra arriva fino alla sua fine.
  const width = Math.max(0, position(addDays(read.end, 1)) - left);
  const duration = formatReadDays(read.days) + (startsBefore ? ' ←' : '');
  const color = read.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR;
  const tip = {
    title: read.title,
    lines: [
      {
        color,
        text: `${read.start ? formatDaySlash(read.start) : '?'} → ${formatDaySlash(read.end)}${startsBefore ? ` (iniziato nel ${read.start!.slice(0, 4)})` : ''}`,
      },
      { text: formatReadDays(read.days) },
      ...(read.rating ? [{ text: `Voto ${formatRating(read.rating)}` }] : []),
    ],
  };
  return (
    <Hit
      data-kind={read.kind === 'fanfic' ? 'fanfic' : 'book'}
      tip={tip}
      book={{ id: read.id }}
      label={`${read.title}, ${formatReadDays(read.days)}`}
      className="stats-item flex w-full flex-col justify-center gap-1 rounded-md text-left max-sm:min-h-10 sm:grid sm:min-h-[30px] sm:grid-cols-[240px_minmax(0,1fr)_96px] sm:items-center sm:gap-x-3.5"
    >
      <span className="flex justify-between gap-2 text-[13px] sm:contents">
        <span className="truncate text-ink-100">{read.title}</span>
        <span className="shrink-0 text-ink-200 sm:order-3 sm:text-right sm:text-[12.5px]">{duration}</span>
      </span>
      <span className="relative block h-2 rounded bg-[#f4f0e7] sm:h-3.5 sm:rounded-none sm:bg-transparent">
        <span
          className="pointer-events-none absolute inset-0 max-sm:hidden"
          style={{ background: 'repeating-linear-gradient(90deg, #f4f0e7 0 1px, transparent 1px 10%)' }}
        />
        <span
          className="absolute top-0 block h-2 min-w-[8px] rounded sm:top-0.5 sm:h-2.5 sm:min-w-[10px] sm:rounded-[5px]"
          style={{ left: `${left * 100}%`, width: `${width * 100}%`, background: color }}
        />
      </span>
    </Hit>
  );
}

function HeatCard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const [table, toggleTable] = useDataView();
  const title = selected === 'all' ? 'Giornate di lettura negli ultimi 12 mesi' : `Giornate di lettura nel ${selected}`;
  const has = stats.readingDaysCount > 0;
  const rows: DataRow[] = Object.keys(stats.readingDays)
    .sort()
    .map((day) => {
      const entry = stats.readingDays[day];
      return {
        key: day,
        label: formatDaySlash(day),
        cells: [entry.books.length, entry.highlights],
        list: entry.books.length > 0 ? daySpec(day, entry) : undefined,
      };
    });
  return (
    <div className={`${CARD} flex flex-col gap-3.5`}>
      <CardTitle
        title={title}
        note={
          has
            ? `${plural(stats.readingDaysCount, 'giornata di lettura', 'giornate di lettura')} · ${plural(stats.highlightsTotal, 'sottolineatura', 'sottolineature')}`
            : undefined
        }
        right={
          has ? (
            <div className="flex flex-wrap items-center gap-3">
              {!table && (
                <div className="max-sm:hidden">
                  <HeatLegend />
                </div>
              )}
              <DataToggle table={table} onToggle={toggleTable} />
            </div>
          ) : undefined
        }
      />
      {!has ? (
        <EmptyNote>
          Nessuna giornata di lettura in questo periodo: il calendario si riempie con le aperture in Apple Books, il
          lettore, le date di inizio e fine e le sottolineature.
        </EmptyNote>
      ) : table ? (
        <DataTable caption={title} head={['Giorno', 'Libri', 'Sottolineature']} rows={rows} tall />
      ) : (
        <>
          <HeatCalendar stats={stats} />
          <div className="sm:hidden">
            <HeatLegend />
          </div>
        </>
      )}
    </div>
  );
}

function AuthorsCard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const [table, toggleTable] = useDataView();
  const max = Math.max(...stats.topAuthors.map((item) => item.count), 1);
  const listOf = (author: ReadingStats['topAuthors'][number]): ListSpec => ({
    title: `${author.name}, ${selected === 'all' ? 'opere lette' : `lette nel ${selected}`}`,
    ids: author.ids,
    date: 'finished',
    // Con «Sempre» le opere lette di un autore sono proprio il filtro autore + letti.
    filter: selected === 'all' ? { authors: [author.name], readingStatus: READ_STATUSES } : undefined,
  });
  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-100 sm:text-[17px]">Autori più letti</h2>
        {stats.topAuthors.length > 0 && <DataToggle table={table} onToggle={toggleTable} />}
      </div>
      {stats.topAuthors.length === 0 ? (
        <EmptyNote>Nessuna opera letta in questo periodo.</EmptyNote>
      ) : table ? (
        <DataTable
          caption="Autori più letti"
          head={['Autore', 'Letti']}
          rows={stats.topAuthors.map((author) => ({
            key: author.name,
            label: author.name,
            cells: [author.count],
            list: listOf(author),
          }))}
        />
      ) : (
        <div className="stats-group flex flex-col">
          {stats.topAuthors.map((author) => (
            <Hit
              key={author.name}
              tip={{ title: author.name, lines: [{ color: BOOK_COLOR, text: plural(author.count, 'opera letta', 'opere lette') }] }}
              list={listOf(author)}
              className="stats-item grid min-h-10 w-full grid-cols-[124px_minmax(0,1fr)_22px] items-center gap-2.5 rounded-md text-left sm:grid-cols-[150px_minmax(0,1fr)_28px] sm:gap-3"
            >
              <span className="truncate text-[13px] sm:text-[13.5px]">{author.name}</span>
              <span className="block h-2 rounded-full bg-ink-750 sm:h-2.5">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${(author.count / max) * 100}%`, background: BOOK_COLOR }}
                />
              </span>
              <span className="text-right text-[13px] font-semibold">{author.count}</span>
            </Hit>
          ))}
        </div>
      )}
    </div>
  );
}

function HighlightedCard({ stats }: { stats: ReadingStats }) {
  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <h2 className="text-base font-semibold text-ink-100 sm:text-[17px]">I più sottolineati</h2>
      {stats.topHighlighted.length === 0 ? (
        <EmptyNote>Nessuna sottolineatura in questo periodo.</EmptyNote>
      ) : (
        <div className="stats-group flex flex-col">
          {stats.topHighlighted.map((item) => (
            <Hit
              key={item.id}
              tip={{ title: item.title, lines: [{ text: plural(item.count, 'sottolineatura', 'sottolineature') }] }}
              book={{ id: item.id, tab: 'highlights' }}
              className="stats-item flex min-h-12 w-full items-center justify-between gap-3 border-b border-ink-750 py-2.5 text-left last:border-b-0"
            >
              <span className="min-w-0 truncate text-sm">{item.title}</span>
              <span className="shrink-0 text-[13px] text-ink-200">
                <strong>{numberFormat.format(item.count)}</strong> {item.count === 1 ? 'sottolineatura' : 'sottolineature'}
              </span>
            </Hit>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StatsDiary({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const { tiles } = stats;
  const period = tiles.period;
  const label = selected === 'all' ? '' : ` nel ${selected}`;
  const summary = [
    `${plural(period.read.total, 'opera letta', 'opere lette')}${label}`,
    period.words > 0 ? formatWordsLong(period.words) : '',
    period.words > 0 ? formatHours(period.hours) + ' di lettura' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const split = (value: { books: number; fanfics: number }) =>
    stats.hasFanfics ? `${value.books} libri · ${value.fanfics} fanfic` : plural(value.books, 'libro', 'libri');
  const sinceLabel = selected === 'all' ? '' : ` nel ${selected}`;
  const ratedIds = stats.ratingDistribution.flatMap((item) => item.ids);
  const readsLabel = selected === 'all' ? 'letture degli ultimi 12 mesi' : `letture del ${selected}`;
  return (
    <div className="flex flex-col gap-4 sm:gap-7">
      <header className="flex flex-col gap-1.5 sm:gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6b655a]">Statistiche</p>
        <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.02em] sm:text-[44px] sm:tracking-[-0.03em]">
          Il tuo diario di lettura
        </h1>
        <p className="text-sm text-ink-300 sm:text-[17px]">{summary}</p>
      </header>

      <section className="grid grid-cols-2 gap-2.5 sm:gap-3.5 lg:grid-cols-4">
        <Tile
          label="Letti"
          value={numberFormat.format(period.read.total)}
          hint={selected === 'all' ? `su ${numberFormat.format(tiles.total.total)} opere` : split(period.read)}
          list={{
            title: `opere lette${sinceLabel}`,
            ids: stats.ids.periodRead,
            date: 'finished',
            filter: selected === 'all' ? { readingStatus: READ_STATUSES } : undefined,
          }}
        />
        <Tile
          label="In lettura"
          value={numberFormat.format(tiles.reading.total)}
          hint="iniziati e non finiti"
          list={{ title: 'in lettura', ids: stats.ids.reading, date: 'none', filter: { readingStatus: ['reading'] } }}
        />
        <Tile
          className="max-sm:hidden"
          label="Abbandonati"
          value={numberFormat.format(tiles.dnf.total)}
          hint="segnati DNF"
          list={{ title: 'abbandonate', ids: stats.ids.dnf, date: 'none', filter: { readingStatus: ['dnf'] } }}
        />
        <Tile
          className="sm:hidden"
          label={selected === 'all' ? 'Ultimi 12 mesi' : `Nel ${selected}`}
          value={numberFormat.format(stats.reads.count.total)}
          hint={split(stats.reads.count)}
          list={{ title: readsLabel, ids: stats.reads.items.map((item) => item.id), date: 'finished' }}
        />
        <Tile
          label="Voto medio"
          value={period.averageRating === null ? '—' : formatRating(period.averageRating)}
          hint={`su ${plural(period.rated, 'voto', 'voti')} · ${period.fiveStars} da 5 stelle`}
          list={{ title: `opere votate${sinceLabel}`, ids: ratedIds, date: 'finished', order: 'rating' }}
        />
      </section>

      <section className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <YearsChart stats={stats} selected={selected} />
        <StatusCard stats={stats} />
      </section>

      <Timeline stats={stats} selected={selected} />
      <HeatCard stats={stats} selected={selected} />

      <section className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <AuthorsCard stats={stats} selected={selected} />
        <HighlightedCard stats={stats} />
      </section>

      <p className="text-xs text-[#6b655a]">
        L'inizio è stimato dalla prima apertura o dalla prima sottolineatura in Apple Books, oppure dal primo
        salvataggio nel lettore; le date di fine vengono dalla scheda e da Apple Books.
      </p>
    </div>
  );
}
