import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { ReadingStats } from '@shared/types';

// Pezzi condivisi dalle tre viste delle statistiche: formati, legenda, calendario.

export const BOOK_COLOR = '#1baf7a';
export const FANFIC_COLOR = '#eb6834';
/** Font dei titoli di «Il tuo anno»: la CSP non ammette i Google Fonts, quindi un serif di sistema. */
export const SERIF = "Georgia, 'Iowan Old Style', serif";

export const numberFormat = new Intl.NumberFormat('it-IT');

const MONTHS_LONG = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
export const MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

const DAY_MS = 86400000;

/* --- date --- */

export function dayTime(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

export function dayString(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function addDays(day: string, amount: number): string {
  return dayString(dayTime(day) + amount * DAY_MS);
}

/** «22 agosto 2025». */
export function formatDayLong(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS_LONG[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** «22 agosto» (senza anno). */
export function formatDayMonth(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS_LONG[Number(day.slice(5, 7)) - 1]}`;
}

/** «22/08/2025». */
export function formatDaySlash(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

export function monthName(month: string): string {
  return MONTHS_LONG[Number(month.slice(5, 7)) - 1];
}

/** «luglio 2026». */
export function formatMonthYear(month: string): string {
  return `${monthName(month)} ${month.slice(0, 4)}`;
}

/** «a marzo», «ad aprile»: la d eufonica davanti alla a. */
export function inMonth(month: string): string {
  const name = monthName(month);
  return name.startsWith('a') ? `ad ${name}` : `a ${name}`;
}

/* --- numeri e testi --- */

export function plural(count: number, one: string, many: string): string {
  return `${numberFormat.format(count)} ${count === 1 ? one : many}`;
}

/** Voto o media con la virgola («4,0»). */
export function formatRating(value: number): string {
  return value.toFixed(1).replace('.', ',');
}

/** «17,1 M», «820 k»: per le schede strette. */
export function formatShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',')} M`;
  if (value >= 1000) return `${Math.round(value / 1000)} k`;
  return String(value);
}

/** «17,1 milioni di parole», «820 mila parole». */
export function formatWordsLong(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',')} milioni di parole`;
  if (value >= 1000) return `${numberFormat.format(Math.round(value / 1000))} mila parole`;
  return `${numberFormat.format(value)} parole`;
}

/** «circa 1.240 ore»: sopra le 100 ore si arrotonda alla decina. */
export function formatHours(hours: number): string {
  if (hours < 1) return 'meno di un\'ora';
  const rounded = hours >= 100 ? Math.round(hours / 10) * 10 : Math.round(hours);
  return `circa ${numberFormat.format(rounded)} ${rounded === 1 ? 'ora' : 'ore'}`;
}

/** Giorni come numero («1,5 giorni», «Stesso giorno»). */
export function formatDaysValue(days: number): string {
  if (days === 0) return 'Stesso giorno';
  const text = Number.isInteger(days) ? String(days) : days.toFixed(1).replace('.', ',');
  return `${text} ${days === 1 ? 'giorno' : 'giorni'}`;
}

/** «un giorno e mezzo», «3 giorni»: per le frasi. */
export function daysPhrase(days: number): string {
  const whole = Math.floor(days);
  const half = days - whole >= 0.5;
  if (days === 1) return 'un giorno';
  if (half) return whole === 0 ? 'mezza giornata' : whole === 1 ? 'un giorno e mezzo' : `${whole} giorni e mezzo`;
  return `${whole} giorni`;
}

/** Durata di una lettura, per le righe della linea del tempo. */
export function formatReadDays(days: number | null): string {
  if (days === null) return 'inizio ignoto';
  if (days === 0) return 'stesso giorno';
  return days === 1 ? '1 giorno' : `${numberFormat.format(days)} giorni`;
}

/* --- suggerimenti --- */

/** Attributi per un suggerimento: `title` per il mouse, `data-tip` per il tocco (vedi StatsView). */
export function tipProps(text: string): { title: string; 'data-tip': string } {
  return { title: text, 'data-tip': text };
}

/* --- elementi comuni --- */

export function KindLegend({ hasFanfics }: { hasFanfics: boolean }) {
  return (
    <div className="flex gap-3.5 text-[12.5px] text-ink-200">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: BOOK_COLOR }} />
        Libri
      </span>
      {hasFanfics && (
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: FANFIC_COLOR }} />
          Fanfiction
        </span>
      )}
    </div>
  );
}

/** Messaggio breve al posto di un grafico che non avrebbe dati. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl bg-ink-800 px-3.5 py-4 text-[12.5px] leading-relaxed text-ink-300">{children}</p>
  );
}

/* --- calendario delle sottolineature --- */

export const HEAT_CLASSES = ['bg-ink-750', 'bg-accent-200', 'bg-accent-300', 'bg-accent-500', 'bg-accent-600'];
const HEAT_LABELS = ['nessuna', '1–4', '5–14', '15–29', '30 o più'];

export function heatBucket(count: number): number {
  if (count <= 0) return 0;
  if (count < 5) return 1;
  if (count < 15) return 2;
  if (count < 30) return 3;
  return 4;
}

export function HeatLegend() {
  return (
    <div className="flex items-center gap-1 text-[11.5px] text-ink-400">
      <span className="mr-1">meno</span>
      {HEAT_CLASSES.map((cls, index) => (
        <span key={cls} className={`h-3 w-3 rounded-[3px] ${cls}`} {...tipProps(HEAT_LABELS[index])} />
      ))}
      <span className="ml-1">più</span>
    </div>
  );
}

/**
 * Un quadrato per giorno, una colonna per settimana (dal lunedi'), come le tavole.
 * Scorre in orizzontale dentro il suo riquadro e parte dalla fine (i giorni piu' recenti).
 */
export function HeatCalendar({ stats }: { stats: ReadingStats }) {
  const ref = useRef<HTMLDivElement>(null);
  const { from, to, today } = stats.window;
  const last = to < today ? to : today;
  const first = dayTime(from);
  // dayTime e' UTC: getUTCDay() 0 = domenica; la settimana parte dal lunedi'.
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells: ReactNode[] = [];
  for (let index = 0; index < lead; index += 1) cells.push(<span key={`b${index}`} />);
  for (let time = first; time <= dayTime(last); time += DAY_MS) {
    const day = dayString(time);
    const count = stats.highlightsByDay[day] ?? 0;
    cells.push(
      <span
        key={day}
        className={`h-[var(--c)] w-[var(--c)] rounded-[3px] ${HEAT_CLASSES[heatBucket(count)]}`}
        {...tipProps(
          `${formatDaySlash(day)}: ${count ? plural(count, 'sottolineatura', 'sottolineature') : 'nessuna sottolineatura'}`,
        )}
      />,
    );
  }
  useEffect(() => {
    const node = ref.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [stats]);
  return (
    <div ref={ref} className="overflow-x-auto pb-1">
      <div
        className="grid w-max grid-flow-col gap-[3px] [--c:12px] sm:[--c:14px]"
        style={{ gridTemplateRows: 'repeat(7, var(--c))', gridAutoColumns: 'var(--c)' }}
      >
        {cells}
      </div>
    </div>
  );
}
