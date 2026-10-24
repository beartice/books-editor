import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { ReadingStats } from '@shared/types';
import { Hit, activateTip, hideTip, isKeyboardFocus, showTipAt, showTipOn, useStatsUi } from './StatsUi';
import type { ListSpec, TipContent } from './StatsUi';

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

/* --- elementi comuni --- */

/** Legenda Libri / Fanfiction: passandoci sopra (o col focus) si attenua l'altra serie. */
export function KindLegend({ hasFanfics }: { hasFanfics: boolean }) {
  return (
    <div className="flex gap-1.5 text-[12.5px] text-ink-200">
      <span tabIndex={0} className="legend-book flex min-h-8 items-center gap-1.5 rounded-md px-1.5">
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: BOOK_COLOR }} />
        Libri
      </span>
      {hasFanfics && (
        <span tabIndex={0} className="legend-fanfic flex min-h-8 items-center gap-1.5 rounded-md px-1.5">
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

/* --- calendario delle giornate di lettura --- */

// Vuoto, letto senza sottolineature (il verde piu' chiaro), poi le sottolineature in tre passi.
export const HEAT_CLASSES = ['bg-ink-750', 'bg-accent-200', 'bg-accent-400', 'bg-accent-500', 'bg-accent-700'];
const HEAT_LABELS = ['non letto', 'letto', '1–14 sottolineature', '15–29 sottolineature', '30 o più sottolineature'];

/** 0 = nessuna lettura, 1 = letto senza sottolineature, 2-4 = sottolineature (1-14, 15-29, 30+). */
export function heatBucket(read: boolean, highlights: number): number {
  if (highlights >= 30) return 4;
  if (highlights >= 15) return 3;
  if (highlights >= 1) return 2;
  return read ? 1 : 0;
}

export function HeatLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-400">
      <span className="flex items-center gap-1.5">
        <span className={`h-3 w-3 rounded-[3px] ${HEAT_CLASSES[0]}`} />
        non letto
      </span>
      <span className="flex items-center gap-1.5">
        <span className={`h-3 w-3 rounded-[3px] ${HEAT_CLASSES[1]}`} />
        letto
      </span>
      <span className="flex items-center gap-1">
        sottolineature
        <span className="ml-0.5">poche</span>
        {HEAT_CLASSES.slice(2).map((cls, index) => (
          <Hit
            key={cls}
            tip={{ title: HEAT_LABELS[index + 2] }}
            focusable={false}
            className={`inline-block h-3 w-3 rounded-[3px] ${cls}`}
          />
        ))}
        <span>molte</span>
      </span>
    </div>
  );
}

/** Suggerimento di un giorno: la data, i libri letti e le sottolineature. */
function dayTip(day: string, entry: ReadingStats['readingDays'][string] | undefined): TipContent {
  const title = formatDayLong(day);
  if (!entry) return { title, lines: [{ text: 'Nessuna lettura' }] };
  const lines = entry.books.slice(0, 4).map((book) => ({
    text: `${book.title || 'Senza titolo'}${book.highlights ? ` · ${plural(book.highlights, 'sottolineatura', 'sottolineature')}` : ''}`,
  }));
  if (entry.books.length > 4) lines.push({ text: `e altre ${entry.books.length - 4}` });
  if (entry.highlights > 0 && entry.books.length !== 1) {
    lines.push({ text: `${plural(entry.highlights, 'sottolineatura', 'sottolineature')} in tutto` });
  }
  return { title, lines };
}

/** Elenco delle opere di un giorno del calendario, con le sottolineature di quel giorno. */
export function daySpec(day: string, entry: ReadingStats['readingDays'][string]): ListSpec {
  const highlights: Record<string, number> = {};
  for (const book of entry.books) if (book.highlights > 0) highlights[book.id] = book.highlights;
  return {
    title: `giornata del ${formatDayLong(day)}`,
    ids: entry.books.map((book) => book.id),
    date: 'none',
    order: 'title',
    highlights,
  };
}

/**
 * Un quadrato per giorno, una colonna per settimana (dal lunedi'), come le tavole, con
 * l'etichetta del mese sopra la colonna in cui comincia. Scorre in orizzontale dentro il suo
 * riquadro e parte dalla fine (i giorni piu' recenti).
 * Le ~300 celle non hanno gestori propri: tutto passa da un solo contenitore (delega degli
 * eventi) e il suggerimento e' uno solo, quindi il passaggio non ridisegna la griglia.
 */
export function HeatCalendar({ stats }: { stats: ReadingStats }) {
  const ref = useRef<HTMLDivElement>(null);
  const touching = useRef(false);
  const { openList } = useStatsUi();
  const { from, to, today } = stats.window;
  const last = to < today ? to : today;
  const first = dayTime(from);
  // dayTime e' UTC: getUTCDay() 0 = domenica; la settimana parte dal lunedi'.
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const cells: ReactNode[] = [];
  for (let index = 0; index < lead; index += 1) cells.push(<span key={`b${index}`} />);
  // Una sola cella e' nell'ordine del Tab (le frecce spostano il focus): l'ultimo giorno con letture.
  const readDays = Object.keys(stats.readingDays).filter((day) => day <= last).sort();
  const tabDay = readDays[readDays.length - 1] ?? last;
  const labels: { text: string; column: number }[] = [];
  for (let time = first; time <= dayTime(last); time += DAY_MS) {
    const day = dayString(time);
    const entry = stats.readingDays[day];
    if (day.endsWith('-01')) {
      const month = Number(day.slice(5, 7));
      labels.push({
        text: MONTHS_SHORT[month - 1] + (month === 1 ? ` ’${day.slice(2, 4)}` : ''),
        column: Math.floor((lead + (time - first) / DAY_MS) / 7),
      });
    }
    cells.push(
      <button
        key={day}
        type="button"
        data-day={day}
        tabIndex={day === tabDay ? 0 : -1}
        aria-label={`${formatDayLong(day)}: ${entry ? 'letto' : 'nessuna lettura'}`}
        className={`heat-cell block h-[var(--c)] w-[var(--c)] rounded-[3px] ${entry ? 'cursor-pointer' : 'cursor-default'} ${HEAT_CLASSES[heatBucket(Boolean(entry), entry?.highlights ?? 0)]}`}
      />,
    );
  }
  useEffect(() => {
    const node = ref.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [stats]);

  const cellOf = (target: EventTarget) => (target as HTMLElement).closest<HTMLElement>('[data-day]');
  const onMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') return;
    const cell = cellOf(event.target);
    if (!cell) return hideTip();
    const day = cell.dataset.day!;
    showTipAt(cell, dayTip(day, stats.readingDays[day]), event.clientX, event.clientY);
  };
  const onClick = (event: MouseEvent<HTMLElement>) => {
    const cell = cellOf(event.target);
    if (!cell) return;
    const day = cell.dataset.day!;
    const entry = stats.readingDays[day];
    const spec = entry && entry.books.length > 0 ? daySpec(day, entry) : null;
    activateTip(
      cell,
      dayTip(day, entry),
      spec
        ? { label: `Vedi ${spec.ids.length} ${spec.ids.length === 1 ? 'opera' : 'opere'}`, run: () => openList(spec) }
        : null,
      touching.current,
    );
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const cell = cellOf(event.target);
    if (!cell) return;
    // Il Tab resta su una sola cella: quella con il focus.
    ref.current?.querySelector<HTMLElement>('[tabindex="0"]')?.setAttribute('tabindex', '-1');
    cell.setAttribute('tabindex', '0');
    if (isKeyboardFocus()) {
      const day = cell.dataset.day!;
      showTipOn(cell, dayTip(day, stats.readingDays[day]));
    }
  };
  // Frecce: sinistra/destra = una settimana, su/giu' = un giorno.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
    const cell = cellOf(event.target);
    if (!step || !cell) return;
    const next = ref.current?.querySelector<HTMLElement>(`[data-day="${addDays(cell.dataset.day!, step)}"]`);
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div ref={ref} className="overflow-x-auto pb-1">
      <div
        className="w-max [--c:12px] sm:[--c:14px]"
        onPointerMove={onMove}
        onPointerLeave={(event) => event.pointerType !== 'touch' && hideTip()}
        onPointerDown={(event) => {
          touching.current = event.pointerType === 'touch';
        }}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={(event) => {
          if (!touching.current) hideTip(cellOf(event.target) ?? undefined);
        }}
        onKeyDown={onKeyDown}
      >
        <div className="relative mb-1 h-4 text-[11px] text-[#6b655a]">
          {labels.map((label) => (
            <span
              key={label.column}
              className="absolute top-0 whitespace-nowrap"
              style={{ left: `calc(${label.column} * (var(--c) + 3px))` }}
            >
              {label.text}
            </span>
          ))}
        </div>
        <div
          className="grid grid-flow-col gap-[3px]"
          style={{ gridTemplateRows: 'repeat(7, var(--c))', gridAutoColumns: 'var(--c)' }}
        >
          {cells}
        </div>
      </div>
    </div>
  );
}
