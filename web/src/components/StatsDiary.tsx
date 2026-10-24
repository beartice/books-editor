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
  formatDaysValue,
  formatHours,
  formatRating,
  formatReadDays,
  formatWordsLong,
  numberFormat,
  plural,
  tipProps,
} from './StatsParts';

// Vista A «Diario»: totali, letture per anno, linea del tempo, calendario, autori.

const CARD = 'rounded-3xl border border-[#ebe5d9] bg-white p-4 sm:p-6';
const TIMELINE_LIMIT = 13;

function Tile({ label, value, hint, className = '' }: { label: string; value: string; hint: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-0.5 rounded-[18px] border border-[#ebe5d9] bg-white px-4 py-3.5 sm:gap-1.5 sm:rounded-[20px] sm:px-[22px] sm:py-5 ${className}`}>
      <span className="text-[12px] font-semibold text-[#6b655a]">{label}</span>
      <span className="text-[26px] font-semibold tracking-[-0.02em] text-ink-100 sm:text-[34px]">{value}</span>
      <span className="text-[12px] text-[#6b655a] sm:text-[12.5px]">{hint}</span>
    </div>
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
  const max = Math.max(...stats.byYear.map((item) => item.books + item.fanfics), 1);
  const plot = 170;
  return (
    <div className={`${CARD} flex flex-col gap-4 lg:col-span-7`}>
      <CardTitle
        title="Letture per anno"
        note={`Con data di fine: ${numberFormat.format(stats.withFinishDate)} delle ${numberFormat.format(stats.readTotal)} opere lette`}
        right={<KindLegend hasFanfics={stats.hasFanfics} />}
      />
      {stats.byYear.length === 0 ? (
        <EmptyNote>
          Nessuna opera letta ha una data di fine: le date arrivano da Apple Books oppure si inseriscono in «Finito il»
          nella scheda.
        </EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <div style={{ minWidth: stats.byYear.length * 44 }}>
            <div
              className="grid items-end gap-2 border-b border-ink-700 pt-2 sm:gap-[18px]"
              style={{ gridTemplateColumns: `repeat(${stats.byYear.length}, minmax(0, 1fr))`, height: plot + 40 }}
            >
              {stats.byYear.map((item) => {
                const total = item.books + item.fanfics;
                const dim = selected !== 'all' && selected !== item.year;
                return (
                  <div
                    key={item.year}
                    className={`flex h-full flex-col items-center justify-end gap-1.5 ${dim ? 'opacity-40' : ''}`}
                    {...tipProps(
                      `${item.year}: ${plural(item.books, 'libro', 'libri')}${
                        stats.hasFanfics ? `, ${plural(item.fanfics, 'fanfiction', 'fanfiction')}` : ''
                      }`,
                    )}
                  >
                    <span className="text-[13px] font-semibold text-ink-100">{total}</span>
                    <div className="flex w-full max-w-16 flex-col gap-[2px]">
                      {item.fanfics > 0 && (
                        <div
                          className="rounded-t-[4px]"
                          style={{ height: (item.fanfics / max) * plot, background: FANFIC_COLOR }}
                        />
                      )}
                      {item.books > 0 && (
                        <div
                          className="rounded-t-[4px]"
                          style={{ height: (item.books / max) * plot, background: BOOK_COLOR }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              className="mt-2 grid gap-2 sm:gap-[18px]"
              style={{ gridTemplateColumns: `repeat(${stats.byYear.length}, minmax(0, 1fr))` }}
            >
              {stats.byYear.map((item) => (
                <span key={item.year} className="text-center text-[12.5px] text-ink-300">
                  {item.year}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** «Dove sono le tue opere»: barre per stato, in proporzione al piu' numeroso. */
function StatusCard({ stats }: { stats: ReadingStats }) {
  const { tiles } = stats;
  const rows = [
    { label: 'Letti', count: tiles.read.total },
    { label: 'In lettura', count: tiles.reading.total },
    { label: 'Abbandonati', count: tiles.dnf.total },
    { label: 'Da leggere', count: tiles.unread.total },
  ];
  const max = Math.max(...rows.map((row) => row.count), 1);
  const total = tiles.total.total;
  return (
    <div className={`${CARD} flex flex-col gap-3.5 lg:col-span-5`}>
      <CardTitle title="Dove sono le tue opere" note={`${plural(total, 'opera', 'opere')} in libreria`} />
      {rows.map((row) => {
        const pct = total ? Math.round((row.count / total) * 100) : 0;
        return (
          <div key={row.label} className="flex flex-col gap-1.5" {...tipProps(`${row.label}: ${plural(row.count, 'opera', 'opere')}`)}>
            <div className="flex justify-between text-[13.5px]">
              <span className="text-ink-100">{row.label}</span>
              <span className="font-semibold text-ink-200">
                {numberFormat.format(row.count)} <span className="font-normal text-[#6b655a]">· {pct}%</span>
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-ink-750">
              <div
                className="h-full rounded-full bg-accent-600"
                style={{ width: `${(row.count / max) * 100}%`, minWidth: row.count ? 6 : 0 }}
              />
            </div>
          </div>
        );
      })}
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
        right={<KindLegend hasFanfics={stats.hasFanfics} />}
      />
      {items.length === 0 ? (
        <EmptyNote>
          {selected === 'all'
            ? 'Nessuna lettura con data di fine negli ultimi 12 mesi.'
            : `Nessuna lettura finita nel ${selected}.`}
        </EmptyNote>
      ) : (
        <>
          <div className="grid grid-cols-[240px_minmax(0,1fr)_96px] gap-x-3.5 max-sm:hidden">
            <span />
            {axis('')}
            <span />
          </div>
          <div className="flex flex-col-reverse gap-3.5 sm:flex-col sm:gap-0">
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
  const color = read.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR;
  const duration = formatReadDays(read.days) + (startsBefore ? ' ←' : '');
  const tip = `${read.title}: ${read.start ?? '?'} → ${read.end}${startsBefore ? ` (iniziato nel ${read.start!.slice(0, 4)})` : ''}`;
  return (
    <div
      className="flex flex-col gap-1 sm:grid sm:min-h-[30px] sm:grid-cols-[240px_minmax(0,1fr)_96px] sm:items-center sm:gap-x-3.5"
      {...tipProps(tip)}
    >
      <div className="flex justify-between gap-2 text-[13px] sm:contents">
        <span className="truncate text-ink-100">{read.title}</span>
        <span className="shrink-0 text-ink-200 sm:order-3 sm:text-right sm:text-[12.5px]">{duration}</span>
      </div>
      <div className="relative h-2 rounded bg-[#f4f0e7] sm:h-3.5 sm:rounded-none sm:bg-transparent">
        <div
          className="pointer-events-none absolute inset-0 max-sm:hidden"
          style={{ background: 'repeating-linear-gradient(90deg, #f4f0e7 0 1px, transparent 1px 10%)' }}
        />
        <div
          className="absolute top-0 h-2 min-w-[8px] rounded sm:top-0.5 sm:h-2.5 sm:min-w-[10px] sm:rounded-[5px]"
          style={{ left: `${left * 100}%`, width: `${width * 100}%`, background: color }}
        />
      </div>
    </div>
  );
}

function HeatCard({ stats, selected }: { stats: ReadingStats; selected: number | 'all' }) {
  const title = selected === 'all' ? 'Giornate di lettura negli ultimi 12 mesi' : `Giornate di lettura nel ${selected}`;
  return (
    <div className={`${CARD} flex flex-col gap-3.5`}>
      <CardTitle
        title={title}
        note={
          stats.highlightsTotal
            ? `Ogni quadrato è un giorno: più è scuro, più sottolineature hai fatto · ${plural(stats.highlightsTotal, 'sottolineatura', 'sottolineature')} in ${plural(stats.highlightsDays, 'giorno', 'giorni')}`
            : undefined
        }
        right={stats.highlightsTotal ? <div className="max-sm:hidden"><HeatLegend /></div> : undefined}
      />
      {stats.highlightsTotal === 0 ? (
        <EmptyNote>
          Nessuna sottolineatura in questo periodo: il calendario si riempie con quelle fatte in Apple Books e nel
          lettore.
        </EmptyNote>
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

function AuthorsCard({ stats }: { stats: ReadingStats }) {
  const max = Math.max(...stats.topAuthors.map((item) => item.count), 1);
  return (
    <div className={`${CARD} flex flex-col gap-3`}>
      <h2 className="text-base font-semibold text-ink-100 sm:text-[17px]">Autori più letti</h2>
      {stats.topAuthors.length === 0 ? (
        <EmptyNote>Nessuna opera letta in questo periodo.</EmptyNote>
      ) : (
        stats.topAuthors.map((author) => (
          <div
            key={author.name}
            className="grid grid-cols-[124px_minmax(0,1fr)_22px] items-center gap-2.5 sm:grid-cols-[150px_minmax(0,1fr)_28px] sm:gap-3"
            {...tipProps(`${author.name}: ${plural(author.count, 'letto', 'letti')}`)}
          >
            <span className="truncate text-[13px] sm:text-[13.5px]">{author.name}</span>
            <div className="h-2 rounded-full bg-ink-750 sm:h-2.5">
              <div
                className="h-full rounded-full"
                style={{ width: `${(author.count / max) * 100}%`, background: BOOK_COLOR }}
              />
            </div>
            <span className="text-right text-[13px] font-semibold">{author.count}</span>
          </div>
        ))
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
        stats.topHighlighted.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-3 border-b border-ink-750 py-2.5 last:border-b-0"
            {...tipProps(`${item.title}: ${plural(item.count, 'sottolineatura', 'sottolineature')}`)}
          >
            <span className="min-w-0 truncate text-sm">{item.title}</span>
            <span className="shrink-0 text-[13px] text-ink-200">
              <strong>{numberFormat.format(item.count)}</strong> {item.count === 1 ? 'sottolineatura' : 'sottolineature'}
            </span>
          </div>
        ))
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
        />
        <Tile label="In lettura" value={numberFormat.format(tiles.reading.total)} hint="iniziati e non finiti" />
        <Tile className="max-sm:hidden" label="Abbandonati" value={numberFormat.format(tiles.dnf.total)} hint="segnati DNF" />
        <Tile
          className="sm:hidden"
          label={selected === 'all' ? 'Ultimi 12 mesi' : `Nel ${selected}`}
          value={numberFormat.format(stats.reads.count.total)}
          hint={split(stats.reads.count)}
        />
        <Tile
          label="Voto medio"
          value={period.averageRating === null ? '—' : formatRating(period.averageRating)}
          hint={`su ${plural(period.rated, 'voto', 'voti')} · ${period.fiveStars} da 5 stelle`}
        />
      </section>

      <section className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <YearsChart stats={stats} selected={selected} />
        <StatusCard stats={stats} />
      </section>

      <Timeline stats={stats} selected={selected} />
      <HeatCard stats={stats} selected={selected} />

      <section className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <AuthorsCard stats={stats} />
        <HighlightedCard stats={stats} />
      </section>

      <p className="text-xs text-[#6b655a]">
        L'inizio è stimato dalla prima apertura o dalla prima sottolineatura in Apple Books, oppure dal primo
        salvataggio nel lettore; le date di fine vengono dalla scheda e da Apple Books.
      </p>
    </div>
  );
}
