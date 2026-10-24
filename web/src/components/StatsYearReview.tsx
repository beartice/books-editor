import type { CSSProperties, ReactNode } from 'react';
import type { ReadingStats } from '@shared/types';
import {
  BOOK_COLOR,
  EmptyNote,
  FANFIC_COLOR,
  MONTHS_SHORT,
  SERIF,
  daysPhrase,
  formatDayLong,
  formatDayMonth,
  formatDaySlash,
  formatDaysValue,
  inMonth,
  monthName,
  numberFormat,
  plural,
} from './StatsParts';
import { DataTable, DataToggle, Hit, useDataView } from './StatsUi';
import type { ListSpec } from './StatsUi';

// Vista C «Il tuo anno»: poche schede grandi, con frasi generate dai dati dell'anno.

const WORD_NUMBERS = [
  'zero', 'una', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci',
  'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove', 'venti',
];

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Stagione di un mese (AAAA-MM), con l'articolo determinativo e indeterminativo. */
function seasonOf(month: string): { name: string; the: string; a: string } {
  const number = Number(month.slice(5, 7));
  if (number >= 6 && number <= 8) return { name: 'estate', the: "L'estate", a: "un'estate" };
  if (number >= 9 && number <= 11) return { name: 'autunno', the: "L'autunno", a: 'un autunno' };
  if (number === 12 || number <= 2) return { name: 'inverno', the: "L'inverno", a: "un inverno" };
  return { name: 'primavera', the: 'La primavera', a: 'una primavera' };
}

/** Un mese ha concentrato le sottolineature (almeno 30, e oltre un terzo del totale)? */
function isConcentrated(stats: ReadingStats): boolean {
  const busiest = stats.busiestMonth;
  return busiest !== null && stats.highlightsTotal >= 30 && busiest.count / stats.highlightsTotal >= 0.35;
}

/**
 * Frase di apertura, solo da regole semplici sui dati: quante letture, se quasi tutte sono
 * finite in due giorni, se un mese ha concentrato le sottolineature. Altrimenti resta neutra.
 */
function headline(stats: ReadingStats): string {
  const count = stats.reads.count.total;
  const number = count <= 20 ? WORD_NUMBERS[count] : String(count);
  let text = `${capitalize(number)} ${count === 1 ? 'storia finita' : 'storie finite'}`;
  const known = stats.reads.withStart;
  const quick = stats.reads.buckets.filter((bucket) => bucket.key === 'same' || bucket.key === 'short');
  const quickCount = quick.reduce((sum, bucket) => sum + bucket.count, 0);
  if (count >= 3 && known >= 3 && quickCount / known >= 0.7) text += ', quasi tutte in un soffio';
  if (stats.busiestMonth && isConcentrated(stats)) {
    const season = seasonOf(stats.busiestMonth.month);
    text += `${text.includes(',') ? ',' : ''} e ${season.a} piena di sottolineature`;
  }
  return `${text}.`;
}

const cardBase = 'flex flex-col gap-2 rounded-[28px] p-5 sm:p-[26px]';
const serif: CSSProperties = { fontFamily: SERIF };

function BigNumber({ children, size = 56 }: { children: ReactNode; size?: number }) {
  return (
    <span
      className="font-semibold leading-none max-sm:!text-[44px]"
      style={{ ...serif, fontSize: size }}
    >
      {children}
    </span>
  );
}

function FinishedCard({ stats, year }: { stats: ReadingStats; year: number }) {
  const { books, fanfics, total } = stats.reads.count;
  const items = stats.reads.items;
  const listOf = (title: string, kind?: 'book' | 'fanfic'): ListSpec => ({
    title,
    ids: items.filter((item) => !kind || (kind === 'fanfic') === (item.kind === 'fanfic')).map((item) => item.id),
    date: 'finished',
  });
  const all = listOf(`letture del ${year}`);
  return (
    <div className="flex min-h-[220px] flex-col justify-between gap-6 rounded-[28px] bg-accent-600 p-6 text-white sm:min-h-[280px] sm:p-8 lg:col-span-5">
      <span className="text-[13px] font-semibold text-accent-100">Letture finite</span>
      <div className="flex flex-col gap-2.5">
        <Hit
          tip={{ title: `Letture finite nel ${year}`, lines: [{ text: plural(total, 'lettura', 'letture') }] }}
          list={all}
          className="self-start rounded-xl text-left"
        >
          <span className="block text-[88px] font-semibold leading-[0.9] sm:text-[120px]" style={serif}>
            {total}
          </span>
        </Hit>
        <span className="text-base text-accent-50">
          {stats.hasFanfics && fanfics > 0
            ? `${plural(books, 'libro', 'libri')} e ${fanfics} fanfiction`
            : plural(books, 'libro', 'libri')}
        </span>
      </div>
      {total > 0 && (
        <div className="stats-group flex h-3 gap-[2px] overflow-hidden rounded-md">
          {books > 0 && (
            <Hit
              data-kind="book"
              tip={{ title: `Libri letti nel ${year}`, lines: [{ color: BOOK_COLOR, text: plural(books, 'libro', 'libri') }] }}
              list={listOf(`libri letti nel ${year}`, 'book')}
              className="stats-item block h-full"
              style={{ flex: books, background: BOOK_COLOR }}
            />
          )}
          {stats.hasFanfics && fanfics > 0 && (
            <Hit
              data-kind="fanfic"
              tip={{
                title: `Fanfiction lette nel ${year}`,
                lines: [{ color: FANFIC_COLOR, text: plural(fanfics, 'fanfiction', 'fanfiction') }],
              }}
              list={listOf(`fanfiction lette nel ${year}`, 'fanfic')}
              className="stats-item block h-full"
              style={{ flex: fanfics, background: FANFIC_COLOR }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function listTitles(titles: string[]): string {
  const short = titles.map((title) => (title.length > 34 ? `${title.slice(0, 33).trimEnd()}…` : title));
  if (short.length <= 3) {
    return short.length > 1 ? `${short.slice(0, -1).join(', ')} e ${short[short.length - 1]}` : short[0];
  }
  return `${short.slice(0, 3).join(', ')} e altre ${short.length - 3}`;
}

function FactCards({ stats, year }: { stats: ReadingStats; year: number }) {
  const { reads, tiles } = stats;
  const median = reads.medianDays;
  const sameDay = reads.items.filter((item) => item.days === 0);
  const longest = reads.longest;
  const read = tiles.period.read.total;
  const five = tiles.period.fiveStars;
  const rated = tiles.period.rated;
  const ratio = read ? five / read : 0;
  // «La piu' veloce»: le letture con inizio noto, dalla piu' breve.
  const byPace = reads.items
    .filter((item) => item.days !== null)
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0) || a.end.localeCompare(b.end));
  const paceNotes: Record<string, string> = {};
  for (const item of byPace) paceNotes[item.id] = formatDaysValue(item.days ?? 0).toLowerCase();
  let fiveText = 'Nessuna lettura ha un voto.';
  if (rated > 0) {
    if (five === 0) fiveText = `Nessuna lettura da cinque stelle nel ${year}.`;
    else if (ratio >= 0.8) fiveText = 'Quasi tutte le letture hanno preso cinque stelle.';
    else if (ratio > 0.5) fiveText = 'Più della metà delle letture ha preso cinque stelle.';
    else if (ratio >= 0.45) fiveText = 'Quasi una lettura su due è stata da cinque stelle.';
    else fiveText = `${Math.round(ratio * 100)}% delle letture ha preso cinque stelle.`;
  }
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:col-span-7">
      <Hit
        tip={{
          title: 'Tempo tipico per finire',
          lines: [{ text: median === null ? 'Manca la data di inizio' : `Mediana ${formatDaysValue(median).toLowerCase()}` }],
        }}
        list={{ title: `letture del ${year}, dalla più veloce`, ids: byPace.map((item) => item.id), order: 'given', notes: paceNotes }}
        className={`${cardBase} border border-[#ebe5d9] bg-white text-left`}
      >
        <span className="text-[13px] font-semibold text-[#6b655a]">Tempo tipico per finire</span>
        <BigNumber>{median === null ? '—' : formatDaysValue(median)}</BigNumber>
        <span className="text-sm text-ink-300">
          {median === null
            ? 'Manca la data di inizio delle letture: arriva da Apple Books o dal lettore.'
            : median === 0
              ? 'Metà delle letture finisce lo stesso giorno in cui comincia.'
              : `Metà delle letture finisce entro ${daysPhrase(median)}.`}
        </span>
      </Hit>
      <Hit
        tip={{ title: 'In un giorno solo', lines: [{ text: plural(sameDay.length, 'lettura', 'letture') }] }}
        list={{ title: `iniziate e finite lo stesso giorno nel ${year}`, ids: sameDay.map((item) => item.id), date: 'finished' }}
        className={`${cardBase} bg-coral-100 text-left`}
      >
        <span className="text-[13px] font-semibold text-[#7a3a22]">In un giorno solo</span>
        <BigNumber>{sameDay.length}</BigNumber>
        <span className="text-sm text-[#5b3a2c]">
          {sameDay.length === 0
            ? 'Nessuna lettura iniziata e finita lo stesso giorno.'
            : `${listTitles(sameDay.map((item) => item.title))}: ${
                sameDay.length === 1 ? 'iniziata e finita' : 'iniziate e finite'
              } lo stesso giorno.`}
        </span>
      </Hit>
      <Hit
        tip={{
          title: 'La lettura più lunga',
          lines: [{ text: longest && longest.days !== null ? `${longest.title}: ${plural(longest.days, 'giorno', 'giorni')}` : 'Servono letture con la data di inizio' }],
        }}
        book={longest && longest.days !== null && longest.start ? { id: longest.id } : undefined}
        className={`${cardBase} border border-[#ebe5d9] bg-white text-left`}
      >
        <span className="text-[13px] font-semibold text-[#6b655a]">La lettura più lunga</span>
        {longest && longest.days !== null && longest.start ? (
          <>
            <span className="text-[26px] font-semibold leading-[1.1] sm:text-[30px]" style={serif}>
              {longest.title}
            </span>
            <span className="text-sm text-ink-300">
              {plural(longest.days, 'giorno', 'giorni')}, dal {formatDayLong(longest.start)} al {formatDayLong(longest.end)}.
            </span>
          </>
        ) : (
          <>
            <BigNumber>—</BigNumber>
            <span className="text-sm text-ink-300">Servono letture con la data di inizio.</span>
          </>
        )}
      </Hit>
      <Hit
        tip={{ title: 'Cinque stelle', lines: [{ text: rated > 0 ? `${five} su ${read} letture` : 'Nessuna lettura ha un voto' }] }}
        list={{ title: `cinque stelle nel ${year}`, ids: stats.ids.fiveStars, date: 'finished' }}
        className={`${cardBase} border border-[#ebe5d9] bg-white text-left`}
      >
        <span className="text-[13px] font-semibold text-[#6b655a]">Cinque stelle</span>
        <BigNumber>{rated > 0 ? `${five} su ${read}` : '—'}</BigNumber>
        <span className="text-sm text-ink-300">{fiveText}</span>
      </Hit>
    </div>
  );
}

function HighlightsCard({ stats, year }: { stats: ReadingStats; year: number }) {
  const [table, toggleTable] = useDataView();
  const months = stats.highlightsByMonth;
  const busiest = stats.busiestMonth;
  const record = stats.recordDay;
  const max = Math.max(...months.map((item) => item.count), 1);
  const plot = 160;
  const listOf = (item: ReadingStats['highlightsByMonth'][number]): ListSpec => ({
    title: `sottolineate ${inMonth(item.month)} ${year}`,
    ids: item.ids,
    date: 'none',
    tab: 'highlights',
  });
  const title =
    busiest && isConcentrated(stats)
      ? `${seasonOf(busiest.month).the} delle sottolineature`
      : 'Le sottolineature, mese per mese';
  return (
    <section className="flex flex-col gap-[18px] rounded-[28px] border border-[#ebe5d9] bg-white p-5 sm:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[26px] font-semibold sm:text-[30px]" style={serif}>
            {title}
          </h2>
          <p className="mt-1.5 text-sm text-ink-300">Sottolineature in Apple Books e nel lettore, mese per mese
            {stats.readingDaysCount > 0 && ` · ${plural(stats.readingDaysCount, 'giornata di lettura', 'giornate di lettura')} nell'anno`}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          {busiest && record && (
            <>
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-[#6b655a]">Mese più intenso</span>
                <span className="text-lg font-semibold">
                  {capitalize(monthName(busiest.month))} · {numberFormat.format(busiest.count)} in {plural(busiest.days, 'giorno', 'giorni')}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-[#6b655a]">Giorno record</span>
                <span className="text-lg font-semibold">
                  {formatDayMonth(record.date)} · {numberFormat.format(record.count)}
                </span>
              </div>
            </>
          )}
          {stats.highlightsTotal > 0 && <DataToggle table={table} onToggle={toggleTable} />}
        </div>
      </div>
      {stats.highlightsTotal === 0 ? (
        <EmptyNote>Nessuna sottolineatura nel {year}.</EmptyNote>
      ) : table ? (
        <DataTable
          caption={title}
          head={['Mese', 'Sottolineature', 'Giorni']}
          rows={months.map((item) => ({
            key: item.month,
            label: capitalize(monthName(item.month)),
            cells: [item.count, item.days],
            list: listOf(item),
          }))}
        />
      ) : (
        <>
          <div
            className="stats-group grid items-end gap-1.5 border-b border-ink-700 sm:gap-2.5"
            style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))`, height: plot + 40 }}
          >
            {months.map((item) => (
              <Hit
                key={item.month}
                tip={{
                  title: `${capitalize(monthName(item.month))} ${year}`,
                  lines: [
                    { color: BOOK_COLOR, text: plural(item.count, 'sottolineatura', 'sottolineature') },
                    ...(item.days ? [{ text: `in ${plural(item.days, 'giorno', 'giorni')}` }] : []),
                  ],
                }}
                list={listOf(item)}
                className="stats-item flex h-full flex-col items-center justify-end gap-1"
              >
                <span className="text-[11px] font-semibold text-ink-100 sm:text-[13px]">{item.count}</span>
                <span
                  className="block w-full max-w-[72px] rounded-t-md"
                  style={{
                    height: Math.max(2, (item.count / max) * plot),
                    background: busiest && item.month === busiest.month ? '#235347' : '#94bfa9',
                  }}
                />
              </Hit>
            ))}
          </div>
          <div
            className="grid gap-1.5 sm:gap-2.5"
            style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
          >
            {months.map((item) => (
              <span key={item.month} className="text-center text-[11px] text-ink-300 sm:text-[13px]">
                {MONTHS_SHORT[Number(item.month.slice(5, 7)) - 1]}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function AddedCard({ stats, year }: { stats: ReadingStats; year: number }) {
  const { total, busiest } = stats.added;
  const concentrated = busiest && total >= 5 && busiest.count / total >= 0.3 && busiest.count < total;
  return (
    <Hit
      tip={{ title: 'Nuove in libreria', lines: [{ text: plural(total, 'opera aggiunta', 'opere aggiunte') }] }}
      list={{
        title: `aggiunte alla libreria nel ${year}`,
        ids: stats.added.byMonth.flatMap((item) => item.ids),
        date: 'added',
      }}
      className={`${cardBase} bg-accent-50 text-left`}
    >
      <span className="text-[13px] font-semibold text-accent-700">Nuove in libreria</span>
      <BigNumber>{numberFormat.format(total)}</BigNumber>
      <span className="text-sm text-accent-700">
        {total === 0
          ? `Nessuna opera aggiunta nel ${year}.`
          : `${total === 1 ? 'opera aggiunta' : 'opere aggiunte'} alla libreria${
              concentrated && busiest ? `, ${busiest.count} solo ${inMonth(busiest.month)}` : ''
            }.`}
      </span>
    </Hit>
  );
}

function TitlesCard({ stats, year }: { stats: ReadingStats; year: number }) {
  const items = stats.reads.items;
  return (
    <div className={`${cardBase} gap-3 border border-[#ebe5d9] bg-white sm:col-span-2`}>
      <span className="text-[13px] font-semibold text-[#6b655a]">Le tue letture del {year}</span>
      {items.length === 0 ? (
        <EmptyNote>Nessuna lettura con data di fine nel {year}.</EmptyNote>
      ) : (
        <div className="stats-group flex flex-wrap gap-2">
          {items.map((item) => (
            <Hit
              key={item.id}
              data-kind={item.kind === 'fanfic' ? 'fanfic' : 'book'}
              tip={{
                title: item.title,
                lines: [
                  {
                    color: item.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR,
                    text: `${item.start ? formatDaySlash(item.start) : '?'} → ${formatDaySlash(item.end)}`,
                  },
                ],
              }}
              book={{ id: item.id }}
              className={`stats-item flex min-h-10 max-w-full items-center gap-2 rounded-full px-3 text-[13.5px] text-ink-100 sm:min-h-0 sm:py-2 ${
                item.kind === 'fanfic' ? 'bg-coral-50' : 'bg-ink-800'
              }`}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: item.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR }}
              />
              <span className="truncate">{item.title}</span>
            </Hit>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StatsYearReview({ stats, year }: { stats: ReadingStats; year: number }) {
  const empty =
    stats.reads.count.total === 0 && stats.highlightsTotal === 0 && stats.added.total === 0;
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <header className="flex flex-col gap-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6b655a]">Riepilogo dell'anno</p>
        <h1
          className="text-[38px] font-semibold leading-none tracking-[-0.02em] sm:text-[64px]"
          style={serif}
        >
          Il tuo {year} in lettura
        </h1>
        {!empty && <p className="max-w-[640px] text-base text-ink-300 sm:text-lg">{headline(stats)}</p>}
      </header>

      {empty ? (
        <EmptyNote>
          Nessuna lettura, sottolineatura o opera aggiunta nel {year}. Scegli un altro anno dal selettore in alto.
        </EmptyNote>
      ) : (
        <>
          <section className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
            <FinishedCard stats={stats} year={year} />
            <FactCards stats={stats} year={year} />
          </section>
          <HighlightsCard stats={stats} year={year} />
          <section className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
            <AddedCard stats={stats} year={year} />
            <TitlesCard stats={stats} year={year} />
          </section>
          <p className="text-xs text-[#6b655a]">
            Conta le opere con data di fine nel {year}. L'inizio è stimato da Apple Books (prima apertura o prima
            sottolineatura) o dal primo salvataggio nel lettore.
          </p>
        </>
      )}
    </div>
  );
}
