import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ReadingStats } from '@shared/types';
import { useStore } from '../store';
import {
  BOOK_COLOR,
  EmptyNote,
  FANFIC_COLOR,
  MONTHS_SHORT,
  daysPhrase,
  formatHours,
  formatMonthYear,
  formatRating,
  formatShort,
  numberFormat,
  plural,
} from './StatsParts';
import StatsOther from './StatsOther';
import { DataTable, DataToggle, Hit, useDataView } from './StatsUi';
import type { ListSpec } from './StatsUi';

const READ_STATUSES = ['read', 'reread'];

// Vista B «Cruscotto»: molti numeri compatti, tutti visibili insieme.

const CARD = 'flex flex-col gap-2.5 rounded-[18px] border border-[#ebe5d9] bg-white p-4 sm:p-[18px]';

function Kpi({ label, value, hint, list }: { label: string; value: string; hint: string; list?: ListSpec }) {
  return (
    <Hit
      tip={{ title: `${label}: ${value}`, lines: [{ text: hint }] }}
      list={list}
      className="flex flex-col gap-0.5 rounded-[14px] bg-ink-800 px-4 py-3.5 text-left"
    >
      <span className="text-[11.5px] font-semibold text-[#6b655a]">{label}</span>
      <span className="text-2xl font-semibold tracking-[-0.02em] text-ink-100">{value}</span>
      <span className="text-[11.5px] text-[#6b655a]">{hint}</span>
    </Hit>
  );
}

function CardHead({ title, note, right }: { title: string; note?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="text-[14.5px] font-semibold text-ink-100">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-[#6b655a]">{note}</p>}
      </div>
      {right}
    </div>
  );
}

function RatingsCard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const [table, toggleTable] = useDataView();
  const { period } = stats.tiles;
  const max = Math.max(...stats.ratingDistribution.map((item) => item.count), 1);
  const plot = 118;
  const where = selected === 'all' ? '' : ` (${selected})`;
  const starsOf = (value: number) => `${formatRating(value).replace(',0', '')} stelle`;
  const listOf = (item: ReadingStats['ratingDistribution'][number]): ListSpec => ({
    title: `voto ${formatRating(item.value).replace(',0', '')}${where}`,
    ids: item.ids,
    date: 'finished',
  });
  return (
    <div className={CARD}>
      <CardHead
        title="Distribuzione dei voti"
        note={
          period.rated
            ? `${plural(period.rated, 'voto', 'voti')} · media ${formatRating(period.averageRating ?? 0)}`
            : undefined
        }
        right={period.rated > 0 ? <DataToggle table={table} onToggle={toggleTable} /> : undefined}
      />
      {period.rated === 0 ? (
        <EmptyNote>Nessun voto in questo periodo: i voti si danno dalla scheda dell'opera.</EmptyNote>
      ) : table ? (
        <DataTable
          caption="Distribuzione dei voti"
          head={['Voto', 'Opere']}
          rows={stats.ratingDistribution.map((item) => ({
            key: String(item.value),
            label: starsOf(item.value),
            cells: [item.count],
            list: listOf(item),
          }))}
        />
      ) : (
        <>
          <div className="stats-group grid h-[150px] grid-cols-10 items-end gap-1 border-b border-ink-700">
            {stats.ratingDistribution.map((item) => (
              <Hit
                key={item.value}
                tip={{ title: starsOf(item.value), lines: [{ color: BOOK_COLOR, text: plural(item.count, 'opera', 'opere') }] }}
                list={listOf(item)}
                className="stats-item flex h-full flex-col items-center justify-end gap-[3px]"
              >
                <span className="text-[10.5px] text-ink-200">{item.count || ''}</span>
                {item.count > 0 && (
                  <span
                    className="block w-full rounded-t-[4px] bg-accent-600"
                    style={{ height: Math.max(3, (item.count / max) * plot) }}
                  />
                )}
              </Hit>
            ))}
          </div>
          <div className="grid grid-cols-10 gap-1">
            {stats.ratingDistribution.map((item) => (
              <span key={item.value} className="text-center text-[10.5px] text-[#6b655a]">
                {String(item.value).replace('.', ',')}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReadingNowCard({ stats }: { stats: ReadingStats }) {
  const { reading } = stats;
  return (
    <div className={CARD}>
      <CardHead
        title="In lettura ora"
        note={reading.total ? `I più avanzati di ${numberFormat.format(reading.total)}` : undefined}
      />
      {reading.items.length === 0 ? (
        <EmptyNote>Nessuna opera in lettura con un avanzamento.</EmptyNote>
      ) : (
        reading.items.map((item) => (
          <Hit
            key={item.id}
            data-kind={item.kind === 'fanfic' ? 'fanfic' : 'book'}
            tip={{
              title: item.title,
              lines: [{ color: item.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR, text: `${item.progress}% letto` }],
            }}
            book={{ id: item.id }}
            className="flex min-h-10 w-full flex-col justify-center gap-1 rounded-md text-left"
          >
            <span className="flex justify-between gap-2 text-[13px]">
              <span className="truncate">{item.title}</span>
              <span className="font-semibold">{item.progress}%</span>
            </span>
            <span className="block h-1.5 rounded-full bg-ink-750">
              <span
                className="block h-full rounded-full"
                style={{ width: `${item.progress}%`, background: item.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR }}
              />
            </span>
          </Hit>
        ))
      )}
    </div>
  );
}

function SpeedCard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const [table, toggleTable] = useDataView();
  const { reads } = stats;
  const max = Math.max(...reads.buckets.map((bucket) => bucket.count), 1);
  const period = selected === 'all' ? 'ultimi 12 mesi' : String(selected);
  const median = reads.medianDays;
  return (
    <div className={CARD}>
      <CardHead
        title="Quanto ci metti"
        note={`Giorni dall'inizio alla fine · ${period}`}
        right={reads.withStart > 0 ? <DataToggle table={table} onToggle={toggleTable} /> : undefined}
      />
      {reads.withStart === 0 || median === null ? (
        <EmptyNote>
          Nessuna lettura di questo periodo ha una data di inizio: arriva da Apple Books, dal lettore o da «Iniziato il»
          nella scheda.
        </EmptyNote>
      ) : (
        <>
          {table ? (
            <DataTable
              caption="Quanto ci metti"
              head={['Fascia', 'Letture']}
              rows={reads.buckets.map((bucket) => ({
                key: bucket.key,
                label: bucket.label,
                cells: [bucket.count],
                list: { title: `${bucket.label.toLowerCase()} (${period})`, ids: bucket.ids, date: 'finished' },
              }))}
            />
          ) : (
            <div className="stats-group flex flex-col gap-0.5">
              {reads.buckets.map((bucket) => (
                <Hit
                  key={bucket.key}
                  tip={{
                    title: bucket.label,
                    lines: [{ color: BOOK_COLOR, text: plural(bucket.count, 'lettura', 'letture') }],
                  }}
                  list={{ title: `${bucket.label.toLowerCase()} (${period})`, ids: bucket.ids, date: 'finished' }}
                  className="stats-item grid min-h-10 w-full grid-cols-[110px_minmax(0,1fr)_30px] items-center gap-2 rounded-md text-left"
                >
                  <span className="text-[12.5px] text-ink-200">{bucket.label}</span>
                  <span className="block h-3.5 rounded bg-ink-750">
                    <span
                      className="block h-full rounded bg-accent-600"
                      style={{ width: `${(bucket.count / max) * 100}%`, minWidth: bucket.count ? 4 : 0 }}
                    />
                  </span>
                  <span className="text-right text-[12.5px] font-semibold">{bucket.count}</span>
                </Hit>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-ink-300">
            {median === 0 ? (
              <>Metà delle letture finisce <strong>lo stesso giorno</strong> in cui comincia</>
            ) : (
              <>
                Metà delle letture finisce in <strong>{daysPhrase(median)}</strong>
              </>
            )}
            {reads.longest && reads.longest.days !== null && reads.longest.days > 0 ? (
              <>
                ; la più lunga è <em>{reads.longest.title}</em> ({plural(reads.longest.days, 'giorno', 'giorni')}).
              </>
            ) : (
              '.'
            )}
          </p>
        </>
      )}
    </div>
  );
}

function MonthsCard({ stats }: { stats: ReadingStats }) {
  const [table, toggleTable] = useDataView();
  const months = stats.highlightsByMonth;
  const max = Math.max(...months.map((item) => item.count), 1);
  const plot = 118;
  const busiest = stats.busiestMonth;
  const listOf = (item: ReadingStats['highlightsByMonth'][number]): ListSpec => ({
    title: `sottolineate a ${formatMonthYear(item.month)}`,
    ids: item.ids,
    date: 'none',
    tab: 'highlights',
  });
  return (
    <div className={`${CARD} lg:col-span-8`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <CardHead
          title="Sottolineature per mese"
          note={`Apple Books e lettore · ${stats.year === 'all' ? 'ultimi 12 mesi' : stats.year}`}
        />
        <div className="flex flex-wrap items-center gap-3">
          {busiest && (
            <span className="text-xs text-ink-200">
              Picco: {formatMonthYear(busiest.month)}, {numberFormat.format(busiest.count)}
            </span>
          )}
          {stats.highlightsTotal > 0 && <DataToggle table={table} onToggle={toggleTable} />}
        </div>
      </div>
      {stats.highlightsTotal === 0 ? (
        <EmptyNote>Nessuna sottolineatura in questo periodo.</EmptyNote>
      ) : table ? (
        <DataTable
          caption="Sottolineature per mese"
          head={['Mese', 'Sottolineature', 'Giorni']}
          rows={months.map((item) => ({
            key: item.month,
            label: formatMonthYear(item.month),
            cells: [item.count, item.days],
            list: listOf(item),
          }))}
        />
      ) : (
        <>
          <div
            className="stats-group grid h-[150px] items-end gap-1.5 border-b border-ink-700"
            style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
          >
            {months.map((item) => (
              <Hit
                key={item.month}
                tip={{
                  title: formatMonthYear(item.month),
                  lines: [
                    { color: BOOK_COLOR, text: plural(item.count, 'sottolineatura', 'sottolineature') },
                    ...(item.days ? [{ text: `in ${plural(item.days, 'giorno', 'giorni')}` }] : []),
                  ],
                }}
                list={listOf(item)}
                className="stats-item flex h-full flex-col items-center justify-end gap-[3px]"
              >
                <span className="text-[10.5px] text-ink-200">{item.count || ''}</span>
                {item.count > 0 && (
                  <span
                    className="block w-full rounded-t-[4px]"
                    style={{ height: Math.max(3, (item.count / max) * plot), background: BOOK_COLOR }}
                  />
                )}
              </Hit>
            ))}
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}>
            {months.map((item) => (
              <span key={item.month} className="text-center text-[10.5px] text-[#6b655a]">
                {MONTHS_SHORT[Number(item.month.slice(5, 7)) - 1]}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function WhatYouReadCard({ stats }: { stats: ReadingStats }) {
  const [table, toggleTable] = useDataView();
  const books = useStore((state) => state.books);
  const { total } = stats.tiles;
  const bookIds = useMemo(() => books.filter((book) => book.kind !== 'fanfic').map((book) => book.id), [books]);
  const fanficIds = useMemo(() => books.filter((book) => book.kind === 'fanfic').map((book) => book.id), [books]);
  const booksList: ListSpec = { title: 'libri', ids: bookIds, date: 'none', filter: { kinds: ['book'] } };
  const fanficsList: ListSpec = { title: 'fanfiction', ids: fanficIds, date: 'none', filter: { kinds: ['fanfic'] } };
  const genreList = (item: ReadingStats['genres'][number]): ListSpec => ({
    title: `${item.genre}, opere lette`,
    ids: item.ids,
    date: 'finished',
  });
  const genres = stats.genres.slice(0, 8);
  return (
    <div className={`${CARD} gap-3 lg:col-span-4`}>
      <CardHead
        title="Cosa leggi"
        right={<DataToggle table={table} onToggle={toggleTable} />}
      />
      {table ? (
        <DataTable
          caption="Cosa leggi"
          head={['Voce', 'Opere']}
          rows={[
            { key: 'books', label: 'Libri', cells: [total.books], list: booksList },
            ...(stats.hasFanfics ? [{ key: 'fanfics', label: 'Fanfiction', cells: [total.fanfics], list: fanficsList }] : []),
            ...genres.map((item) => ({
              key: item.genre,
              label: `Genere: ${item.genre}`,
              cells: [item.count],
              list: genreList(item),
            })),
          ]}
        />
      ) : (
        <>
          {stats.hasFanfics && (
            <div className="stats-group flex h-[18px] gap-[2px] overflow-hidden rounded-md">
              <Hit
                data-kind="book"
                tip={{ title: 'Libri', lines: [{ color: BOOK_COLOR, text: plural(total.books, 'libro', 'libri') }] }}
                list={booksList}
                className="stats-item block h-full"
                style={{ flex: total.books, background: BOOK_COLOR }}
              />
              <Hit
                data-kind="fanfic"
                tip={{ title: 'Fanfiction', lines: [{ color: FANFIC_COLOR, text: plural(total.fanfics, 'fanfiction', 'fanfiction') }] }}
                list={fanficsList}
                className="stats-item block h-full"
                style={{ flex: total.fanfics, background: FANFIC_COLOR }}
              />
            </div>
          )}
          <div className="flex justify-between text-[12.5px]">
            <Hit
              tip={{ title: 'Libri', lines: [{ color: BOOK_COLOR, text: plural(total.books, 'libro', 'libri') }] }}
              list={booksList}
              className="flex min-h-10 items-center gap-1.5 rounded-md"
            >
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: BOOK_COLOR }} />
              Libri <strong>{numberFormat.format(total.books)}</strong>
            </Hit>
            {stats.hasFanfics && (
              <Hit
                tip={{ title: 'Fanfiction', lines: [{ color: FANFIC_COLOR, text: plural(total.fanfics, 'fanfiction', 'fanfiction') }] }}
                list={fanficsList}
                className="flex min-h-10 items-center gap-1.5 rounded-md"
              >
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FANFIC_COLOR }} />
                Fanfiction <strong>{numberFormat.format(total.fanfics)}</strong>
              </Hit>
            )}
          </div>
        </>
      )}
      <h3 className="mt-1.5 text-[13px] font-semibold text-ink-200">Generi più letti (opere lette)</h3>
      {stats.genres.length === 0 ? (
        <EmptyNote>Nessun genere riconosciuto: servono tag come «Fantasy» o «Romance» sulle opere lette.</EmptyNote>
      ) : (
        <div className="stats-group flex flex-wrap gap-1.5">
          {genres.map((item) => (
            <Hit
              key={item.genre}
              tip={{ title: item.genre, lines: [{ text: plural(item.count, 'opera letta', 'opere lette') }] }}
              list={genreList(item)}
              className="stats-item inline-flex min-h-10 items-center rounded-full bg-accent-50 px-3 text-[12.5px] text-accent-700 sm:min-h-8"
            >
              {item.genre} · {item.count}
            </Hit>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StatsDashboard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const books = useStore((state) => state.books);
  const { tiles, reads } = stats;
  const { period } = tiles;
  const split = (value: { books: number; fanfics: number }) =>
    stats.hasFanfics ? `${value.books} libri · ${value.fanfics} fanfic` : plural(value.books, 'libro', 'libri');
  const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
  const allIds = books.map((book) => book.id);
  const ratedIds = stats.ratingDistribution.flatMap((item) => item.ids);
  const sinceLabel = selected === 'all' ? '' : ` nel ${selected}`;
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi
          label="Opere"
          value={numberFormat.format(tiles.total.total)}
          hint={split(tiles.total)}
          list={{ title: 'tutte le opere', ids: allIds, date: 'none', filter: {} }}
        />
        <Kpi
          label="Lette"
          value={numberFormat.format(period.read.total)}
          hint={
            selected === 'all'
              ? `${String(pct(tiles.read.total, tiles.total.total)).replace('.', ',')}% della libreria`
              : `nel ${selected}`
          }
          list={{
            title: `opere lette${sinceLabel}`,
            ids: stats.ids.periodRead,
            date: 'finished',
            filter: selected === 'all' ? { readingStatus: READ_STATUSES } : undefined,
          }}
        />
        <Kpi
          label="Parole lette"
          value={period.words ? formatShort(period.words) : '—'}
          hint={period.words ? formatHours(period.hours) : 'nessuna parola registrata'}
          list={{ title: `opere lette${sinceLabel}`, ids: stats.ids.periodRead, date: 'finished' }}
        />
        <Kpi
          label={selected === 'all' ? 'Ultimi 12 mesi' : `Nel ${selected}`}
          value={numberFormat.format(reads.count.total)}
          hint={split(reads.count)}
          list={{
            title: selected === 'all' ? 'letture degli ultimi 12 mesi' : `letture del ${selected}`,
            ids: reads.items.map((item) => item.id),
            date: 'finished',
          }}
        />
        <Kpi
          label="Voto medio"
          value={period.averageRating === null ? '—' : formatRating(period.averageRating)}
          hint={`${period.fiveStars} da 5 stelle`}
          list={{ title: `opere votate${sinceLabel}`, ids: ratedIds, date: 'finished', order: 'rating' }}
        />
        <Kpi
          label="Abbandonati"
          value={numberFormat.format(tiles.dnf.total)}
          hint={`${String(pct(tiles.dnf.total, tiles.total.total)).replace('.', ',')}% delle opere`}
          list={{ title: 'abbandonate', ids: stats.ids.dnf, date: 'none', filter: { readingStatus: ['dnf'] } }}
        />
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <RatingsCard stats={stats} selected={selected} />
        <ReadingNowCard stats={stats} />
        <SpeedCard stats={stats} selected={selected} />
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <MonthsCard stats={stats} />
        <WhatYouReadCard stats={stats} />
      </section>

      <StatsOther hasFanfics={stats.hasFanfics} />
    </div>
  );
}
