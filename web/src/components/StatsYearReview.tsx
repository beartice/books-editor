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
  tipProps,
} from './StatsParts';

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

function FinishedCard({ stats }: { stats: ReadingStats }) {
  const { books, fanfics, total } = stats.reads.count;
  return (
    <div className="flex min-h-[220px] flex-col justify-between gap-6 rounded-[28px] bg-accent-600 p-6 text-white sm:min-h-[280px] sm:p-8 lg:col-span-5">
      <span className="text-[13px] font-semibold text-accent-100">Letture finite</span>
      <div className="flex flex-col gap-2.5">
        <span
          className="text-[88px] font-semibold leading-[0.9] sm:text-[120px]"
          style={serif}
        >
          {total}
        </span>
        <span className="text-base text-accent-50">
          {stats.hasFanfics && fanfics > 0
            ? `${plural(books, 'libro', 'libri')} e ${fanfics} fanfiction`
            : plural(books, 'libro', 'libri')}
        </span>
      </div>
      {total > 0 && (
        <div
          className="flex h-3 gap-[2px] overflow-hidden rounded-md"
          {...tipProps(`${plural(books, 'libro', 'libri')}${stats.hasFanfics ? `, ${fanfics} fanfiction` : ''}`)}
        >
          {books > 0 && <div style={{ flex: books, background: BOOK_COLOR }} />}
          {stats.hasFanfics && fanfics > 0 && <div style={{ flex: fanfics, background: FANFIC_COLOR }} />}
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
      <div className={`${cardBase} border border-[#ebe5d9] bg-white`}>
        <span className="text-[13px] font-semibold text-[#6b655a]">Tempo tipico per finire</span>
        <BigNumber>{median === null ? '—' : formatDaysValue(median)}</BigNumber>
        <span className="text-sm text-ink-300">
          {median === null
            ? 'Manca la data di inizio delle letture: arriva da Apple Books o dal lettore.'
            : median === 0
              ? 'Metà delle letture finisce lo stesso giorno in cui comincia.'
              : `Metà delle letture finisce entro ${daysPhrase(median)}.`}
        </span>
      </div>
      <div className={`${cardBase} bg-coral-100`}>
        <span className="text-[13px] font-semibold text-[#7a3a22]">In un giorno solo</span>
        <BigNumber>{sameDay.length}</BigNumber>
        <span className="text-sm text-[#5b3a2c]">
          {sameDay.length === 0
            ? 'Nessuna lettura iniziata e finita lo stesso giorno.'
            : `${listTitles(sameDay.map((item) => item.title))}: ${
                sameDay.length === 1 ? 'iniziata e finita' : 'iniziate e finite'
              } lo stesso giorno.`}
        </span>
      </div>
      <div className={`${cardBase} border border-[#ebe5d9] bg-white`}>
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
      </div>
      <div className={`${cardBase} border border-[#ebe5d9] bg-white`}>
        <span className="text-[13px] font-semibold text-[#6b655a]">Cinque stelle</span>
        <BigNumber>{rated > 0 ? `${five} su ${read}` : '—'}</BigNumber>
        <span className="text-sm text-ink-300">{fiveText}</span>
      </div>
    </div>
  );
}

function HighlightsCard({ stats, year }: { stats: ReadingStats; year: number }) {
  const months = stats.highlightsByMonth;
  const busiest = stats.busiestMonth;
  const record = stats.recordDay;
  const max = Math.max(...months.map((item) => item.count), 1);
  const plot = 160;
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
        {busiest && record && (
          <div className="flex flex-wrap gap-x-6 gap-y-2">
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
          </div>
        )}
      </div>
      {stats.highlightsTotal === 0 ? (
        <EmptyNote>Nessuna sottolineatura nel {year}.</EmptyNote>
      ) : (
        <>
          <div
            className="grid items-end gap-1.5 border-b border-ink-700 sm:gap-2.5"
            style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))`, height: plot + 40 }}
          >
            {months.map((item) => (
              <div
                key={item.month}
                className="flex h-full flex-col items-center justify-end gap-1"
                {...tipProps(`${capitalize(monthName(item.month))} ${year}: ${plural(item.count, 'sottolineatura', 'sottolineature')}`)}
              >
                <span className="text-[11px] font-semibold text-ink-100 sm:text-[13px]">{item.count}</span>
                <div
                  className="w-full max-w-[72px] rounded-t-md"
                  style={{
                    height: Math.max(2, (item.count / max) * plot),
                    background: busiest && item.month === busiest.month ? '#235347' : '#94bfa9',
                  }}
                />
              </div>
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
    <div className={`${cardBase} bg-accent-50`}>
      <span className="text-[13px] font-semibold text-accent-700">Nuove in libreria</span>
      <BigNumber>{numberFormat.format(total)}</BigNumber>
      <span className="text-sm text-accent-700">
        {total === 0
          ? `Nessuna opera aggiunta nel ${year}.`
          : `${total === 1 ? 'opera aggiunta' : 'opere aggiunte'} alla libreria${
              concentrated && busiest ? `, ${busiest.count} solo ${inMonth(busiest.month)}` : ''
            }.`}
      </span>
    </div>
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
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <span
              key={item.id}
              className={`flex min-h-10 max-w-full items-center gap-2 rounded-full px-3 text-[13.5px] text-ink-100 sm:min-h-0 sm:py-2 ${
                item.kind === 'fanfic' ? 'bg-coral-50' : 'bg-ink-800'
              }`}
              {...tipProps(
                `${item.title}: ${item.start ? formatDaySlash(item.start) : '?'} → ${formatDaySlash(item.end)}`,
              )}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: item.kind === 'fanfic' ? FANFIC_COLOR : BOOK_COLOR }}
              />
              <span className="truncate">{item.title}</span>
            </span>
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
            <FinishedCard stats={stats} />
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
