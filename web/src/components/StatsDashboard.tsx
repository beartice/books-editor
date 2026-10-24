import type { ReactNode } from 'react';
import type { ReadingStats } from '@shared/types';
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
  tipProps,
} from './StatsParts';
import StatsOther from './StatsOther';

// Vista B «Cruscotto»: molti numeri compatti, tutti visibili insieme.

const CARD = 'flex flex-col gap-2.5 rounded-[18px] border border-[#ebe5d9] bg-white p-4 sm:p-[18px]';

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[14px] bg-ink-800 px-4 py-3.5">
      <span className="text-[11.5px] font-semibold text-[#6b655a]">{label}</span>
      <span className="text-2xl font-semibold tracking-[-0.02em] text-ink-100">{value}</span>
      <span className="text-[11.5px] text-[#6b655a]">{hint}</span>
    </div>
  );
}

function CardHead({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div>
      <h2 className="text-[14.5px] font-semibold text-ink-100">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-[#6b655a]">{note}</p>}
    </div>
  );
}

function RatingsCard({ stats }: { stats: ReadingStats }) {
  const { period } = stats.tiles;
  const max = Math.max(...stats.ratingDistribution.map((item) => item.count), 1);
  const plot = 118;
  return (
    <div className={CARD}>
      <CardHead
        title="Distribuzione dei voti"
        note={
          period.rated
            ? `${plural(period.rated, 'voto', 'voti')} · media ${formatRating(period.averageRating ?? 0)}`
            : undefined
        }
      />
      {period.rated === 0 ? (
        <EmptyNote>Nessun voto in questo periodo: i voti si danno dalla scheda dell'opera.</EmptyNote>
      ) : (
        <>
          <div className="grid h-[150px] grid-cols-10 items-end gap-1 border-b border-ink-700">
            {stats.ratingDistribution.map((item) => (
              <div
                key={item.value}
                className="flex h-full flex-col items-center justify-end gap-[3px]"
                {...tipProps(`${formatRating(item.value).replace(',0', '')} stelle: ${plural(item.count, 'opera', 'opere')}`)}
              >
                <span className="text-[10.5px] text-ink-200">{item.count || ''}</span>
                {item.count > 0 && (
                  <div
                    className="w-full rounded-t-[4px] bg-accent-600"
                    style={{ height: Math.max(3, (item.count / max) * plot) }}
                  />
                )}
              </div>
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
          <div key={item.id} className="flex flex-col gap-1" {...tipProps(`${item.title}: ${item.progress}%`)}>
            <div className="flex justify-between gap-2 text-[13px]">
              <span className="truncate">{item.title}</span>
              <span className="font-semibold">{item.progress}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-ink-750">
              <div
                className="h-full rounded-full"
                style={{ width: `${item.progress}%`, background: item.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR }}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SpeedCard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const { reads } = stats;
  const max = Math.max(...reads.buckets.map((bucket) => bucket.count), 1);
  const period = selected === 'all' ? 'ultimi 12 mesi' : String(selected);
  const median = reads.medianDays;
  return (
    <div className={CARD}>
      <CardHead title="Quanto ci metti" note={`Giorni dall'inizio alla fine · ${period}`} />
      {reads.withStart === 0 || median === null ? (
        <EmptyNote>
          Nessuna lettura di questo periodo ha una data di inizio: arriva da Apple Books, dal lettore o da «Iniziato il»
          nella scheda.
        </EmptyNote>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {reads.buckets.map((bucket) => (
              <div
                key={bucket.key}
                className="grid grid-cols-[110px_minmax(0,1fr)_30px] items-center gap-2"
                {...tipProps(`${bucket.label}: ${plural(bucket.count, 'lettura', 'letture')}`)}
              >
                <span className="text-[12.5px] text-ink-200">{bucket.label}</span>
                <div className="h-3.5 rounded bg-ink-750">
                  <div
                    className="h-full rounded bg-accent-600"
                    style={{ width: `${(bucket.count / max) * 100}%`, minWidth: bucket.count ? 4 : 0 }}
                  />
                </div>
                <span className="text-right text-[12.5px] font-semibold">{bucket.count}</span>
              </div>
            ))}
          </div>
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
  const months = stats.highlightsByMonth;
  const max = Math.max(...months.map((item) => item.count), 1);
  const plot = 118;
  const busiest = stats.busiestMonth;
  return (
    <div className={`${CARD} lg:col-span-8`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <CardHead
          title="Sottolineature per mese"
          note={`Apple Books e lettore · ${stats.year === 'all' ? 'ultimi 12 mesi' : stats.year}`}
        />
        {busiest && (
          <span className="text-xs text-ink-200">
            Picco: {formatMonthYear(busiest.month)}, {numberFormat.format(busiest.count)}
          </span>
        )}
      </div>
      {stats.highlightsTotal === 0 ? (
        <EmptyNote>Nessuna sottolineatura in questo periodo.</EmptyNote>
      ) : (
        <>
          <div
            className="grid h-[150px] items-end gap-1.5 border-b border-ink-700"
            style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
          >
            {months.map((item) => (
              <div
                key={item.month}
                className="flex h-full flex-col items-center justify-end gap-[3px]"
                {...tipProps(`${formatMonthYear(item.month)}: ${plural(item.count, 'sottolineatura', 'sottolineature')}`)}
              >
                <span className="text-[10.5px] text-ink-200">{item.count || ''}</span>
                {item.count > 0 && (
                  <div
                    className="w-full rounded-t-[4px]"
                    style={{ height: Math.max(3, (item.count / max) * plot), background: BOOK_COLOR }}
                  />
                )}
              </div>
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
  const { total } = stats.tiles;
  return (
    <div className={`${CARD} gap-3 lg:col-span-4`}>
      <h2 className="text-[14.5px] font-semibold text-ink-100">Cosa leggi</h2>
      {stats.hasFanfics && (
        <div
          className="flex h-[18px] gap-[2px] overflow-hidden rounded-md"
          {...tipProps(`${plural(total.books, 'libro', 'libri')} e ${total.fanfics} fanfiction`)}
        >
          <div style={{ flex: total.books, background: BOOK_COLOR }} />
          <div style={{ flex: total.fanfics, background: FANFIC_COLOR }} />
        </div>
      )}
      <div className="flex justify-between text-[12.5px]">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: BOOK_COLOR }} />
          Libri <strong>{numberFormat.format(total.books)}</strong>
        </span>
        {stats.hasFanfics && (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FANFIC_COLOR }} />
            Fanfiction <strong>{numberFormat.format(total.fanfics)}</strong>
          </span>
        )}
      </div>
      <h3 className="mt-1.5 text-[13px] font-semibold text-ink-200">Generi più letti (opere lette)</h3>
      {stats.genres.length === 0 ? (
        <EmptyNote>Nessun genere riconosciuto: servono tag come «Fantasy» o «Romance» sulle opere lette.</EmptyNote>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {stats.genres.slice(0, 8).map((item) => (
            <span
              key={item.genre}
              className="rounded-full bg-accent-50 px-2.5 py-1.5 text-[12.5px] text-accent-700"
              {...tipProps(`${item.genre}: ${plural(item.count, 'opera letta', 'opere lette')}`)}
            >
              {item.genre} · {item.count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StatsDashboard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const { tiles, reads } = stats;
  const { period } = tiles;
  const split = (value: { books: number; fanfics: number }) =>
    stats.hasFanfics ? `${value.books} libri · ${value.fanfics} fanfic` : plural(value.books, 'libro', 'libri');
  const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Opere" value={numberFormat.format(tiles.total.total)} hint={split(tiles.total)} />
        <Kpi
          label="Lette"
          value={numberFormat.format(period.read.total)}
          hint={
            selected === 'all'
              ? `${String(pct(tiles.read.total, tiles.total.total)).replace('.', ',')}% della libreria`
              : `nel ${selected}`
          }
        />
        <Kpi
          label="Parole lette"
          value={period.words ? formatShort(period.words) : '—'}
          hint={period.words ? formatHours(period.hours) : 'nessuna parola registrata'}
        />
        <Kpi
          label={selected === 'all' ? 'Ultimi 12 mesi' : `Nel ${selected}`}
          value={numberFormat.format(reads.count.total)}
          hint={split(reads.count)}
        />
        <Kpi
          label="Voto medio"
          value={period.averageRating === null ? '—' : formatRating(period.averageRating)}
          hint={`${period.fiveStars} da 5 stelle`}
        />
        <Kpi
          label="Abbandonati"
          value={numberFormat.format(tiles.dnf.total)}
          hint={`${String(pct(tiles.dnf.total, tiles.total.total)).replace('.', ',')}% delle opere`}
        />
      </section>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <RatingsCard stats={stats} />
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
