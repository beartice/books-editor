import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ButtonHTMLAttributes, FocusEvent, MouseEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Filters } from '../store';

// Interazione delle statistiche: suggerimento ricco (hover, focus, tocco), clic che apre
// l'elenco delle opere, tabella «Mostra dati». I pezzi grafici stanno nelle tre viste.

/* --- tipi --- */

export interface TipLine {
  /** Pallino colorato per l'identita' (libri, fanfiction); senza colore, solo testo. */
  color?: string;
  text: string;
}

export interface TipContent {
  title: string;
  lines?: TipLine[];
}

/** Un insieme di opere da mostrare nel pannello laterale. */
export interface ListSpec {
  /** «letture del 2024»: il pannello dice «Opere: letture del 2024». */
  title: string;
  ids: string[];
  /** Data da mostrare accanto a ogni opera (default: nessuna). */
  date?: 'finished' | 'started' | 'added' | 'none';
  /** Ordine: per data (le piu' recenti prima), per titolo, per voto, o quello degli id. */
  order?: 'date' | 'title' | 'rating' | 'given';
  /** Filtro della libreria equivalente all'insieme, se esiste. */
  filter?: Partial<Filters>;
  /** Nota per opera (es. «73%»). */
  notes?: Record<string, string>;
  /** Sottolineature per opera: nota «N sottolineature» e la scheda si apre su quel tab. */
  highlights?: Record<string, number>;
  /** Tutte le schede si aprono sul tab Sottolineature. */
  tab?: 'highlights';
}

interface StatsUiApi {
  openList: (spec: ListSpec) => void;
  openBook: (id: string, tab?: 'highlights') => void;
}

const StatsUiContext = createContext<StatsUiApi>({ openList: () => undefined, openBook: () => undefined });
export const StatsUiProvider = StatsUiContext.Provider;
export const useStatsUi = () => useContext(StatsUiContext);

/* --- suggerimento: stato fuori da React, cosi' i grafici non si ridisegnano al passaggio --- */

interface TipState {
  content: TipContent;
  /** Mouse: posizione del puntatore. Focus e tocco: riquadro dell'elemento. */
  pointer: { x: number; y: number } | null;
  anchor: DOMRect | null;
  owner: HTMLElement;
  /** Tocco: il riquadro e' cliccabile e ha il pulsante. */
  action: TipAction;
}

let currentTip: TipState | null = null;
// Ultimo modo di input: il suggerimento al focus compare solo se si naviga da tastiera.
let keyboardMode = false;
const tipListeners = new Set<() => void>();

function setTip(next: TipState | null): void {
  currentTip = next;
  tipListeners.forEach((listener) => listener());
}

function hideTip(owner?: HTMLElement): void {
  if (currentTip && (!owner || currentTip.owner === owner)) setTip(null);
}

/** Mostra il suggerimento seguendo il puntatore. */
export function showTipAt(owner: HTMLElement, content: TipContent, x: number, y: number): void {
  setTip({ content, pointer: { x, y }, anchor: null, owner, action: null });
}

/** Mostra il suggerimento ancorato a un elemento (tastiera e tocco). */
export function showTipOn(owner: HTMLElement, content: TipContent, action: TipAction = null): void {
  setTip({ content, pointer: null, anchor: owner.getBoundingClientRect(), owner, action });
}

export { hideTip };

export type TipAction = { label: string; run: () => void } | null;

/**
 * Clic su un elemento. Con il mouse e la tastiera esegue l'azione; sul tocco il primo tap mostra
 * il suggerimento con il pulsante, un secondo tap sullo stesso elemento esegue l'azione.
 */
export function activateTip(node: HTMLElement, tip: TipContent, action: TipAction, touching: boolean): void {
  if (!action) {
    if (touching) showTipOn(node, tip);
    return;
  }
  if (touching && currentTip?.owner !== node) {
    showTipOn(node, tip, action);
    return;
  }
  hideTip();
  action.run();
  // Il focus del mouse non deve lasciare attenuati gli altri elementi del grafico.
  if (!touching && !node.matches(':focus-visible')) node.blur();
}

/** Riquadro unico, reso con un portale sopra a tutto (z-index piu' alto di pannelli e schede). */
export function StatsTooltip() {
  const tip = useSyncExternalStore(
    (listener) => {
      tipListeners.add(listener);
      return () => {
        tipListeners.delete(listener);
      };
    },
    () => currentTip,
  );
  const ref = useRef<HTMLDivElement>(null);

  // Posizione: vicino al puntatore o sopra l'elemento, sempre dentro lo schermo.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !tip) return;
    const margin = 8;
    const { width, height } = node.getBoundingClientRect();
    let left: number;
    let top: number;
    if (tip.pointer) {
      left = tip.pointer.x + 14;
      top = tip.pointer.y + 16;
      if (left + width > window.innerWidth - margin) left = tip.pointer.x - width - 14;
      if (top + height > window.innerHeight - margin) top = tip.pointer.y - height - 12;
    } else if (tip.anchor) {
      left = tip.anchor.left + tip.anchor.width / 2 - width / 2;
      top = tip.anchor.top - height - 8;
      if (top < margin) top = tip.anchor.bottom + 8;
    } else {
      return;
    }
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  });

  // Il tocco fuori dal riquadro e dall'elemento lo chiude; lo scorrimento pure.
  const touchTip = Boolean(tip?.action);
  useEffect(() => {
    if (!touchTip) return;
    const onDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || currentTip?.owner.contains(target)) return;
      setTip(null);
    };
    const onScroll = () => setTip(null);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [touchTip, tip?.owner]);

  // Chiudendo le statistiche non deve restare un suggerimento a mezz'aria.
  useEffect(() => () => hideTip(), []);

  // Tastiera o puntatore: decide se il focus mostra il suggerimento (vedi `isKeyboardFocus`).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') keyboardMode = true;
    };
    const onPointer = () => {
      keyboardMode = false;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={`fixed left-0 top-0 z-[90] max-w-[min(300px,calc(100vw-16px))] rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12.5px] leading-snug text-ink-100 shadow-panel ${
        tip.action ? '' : 'pointer-events-none'
      }`}
    >
      <p className="font-semibold">{tip.content.title}</p>
      {tip.content.lines?.map((line, index) => (
        <p key={index} className="mt-0.5 flex items-center gap-1.5">
          {line.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: line.color }} />}
          <span>{line.text}</span>
        </p>
      ))}
      {tip.action && (
        <button
          type="button"
          onClick={() => {
            const { run } = tip.action!;
            setTip(null);
            run();
          }}
          className="mt-2 flex min-h-10 w-full items-center justify-center rounded-lg bg-accent-600 px-3 text-[13px] font-semibold text-white"
        >
          {tip.action.label}
        </button>
      )}
    </div>,
    document.body,
  );
}

/** true se il focus e' arrivato dalla tastiera (non dal mouse, dal tocco o da `focus()` nel codice). */
export function isKeyboardFocus(): boolean {
  return keyboardMode;
}

/** Testo del suggerimento come stringa unica (per `aria-label`). */
export function tipText(tip: TipContent): string {
  return [tip.title, ...(tip.lines ?? []).map((line) => line.text)].join(', ');
}

/* --- elemento interattivo --- */

interface HitProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'onClick'> {
  tip: TipContent;
  /** Clic: elenco di opere nel pannello. */
  list?: ListSpec;
  /** Clic: scheda di una sola opera (con il tab da aprire). */
  book?: { id: string; tab?: 'highlights' };
  /** `aria-label` se diverso dal testo del suggerimento. */
  label?: string;
  /** false = non entra nell'ordine del Tab (campioni della legenda). */
  focusable?: boolean;
}

/**
 * Un elemento che mostra il suggerimento al passaggio, al focus da tastiera e al tocco, e che
 * al clic apre l'elenco (o la scheda). Se non c'e' niente da aprire e' un semplice `span`
 * focalizzabile con lo stesso suggerimento. Sul tocco il primo tap mostra il suggerimento con
 * il pulsante «Vedi N opere»; un secondo tap sullo stesso elemento apre l'elenco.
 */
export function Hit({ tip, list, book, label, focusable = true, className = '', children, ...rest }: HitProps) {
  const { openList, openBook } = useStatsUi();
  const touching = useRef(false);
  const count = list?.ids.length ?? 0;
  const actionable = Boolean(book) || count > 0;
  const action = book
    ? { label: 'Apri la scheda', run: () => openBook(book.id, book.tab) }
    : count > 0 && list
      ? { label: `Vedi ${count} ${count === 1 ? 'opera' : 'opere'}`, run: () => openList(list) }
      : null;

  const onPointerEnter = (event: PointerEvent<HTMLElement>) => {
    touching.current = event.pointerType === 'touch';
    if (!touching.current) showTipAt(event.currentTarget, tip, event.clientX, event.clientY);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch') showTipAt(event.currentTarget, tip, event.clientX, event.clientY);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    touching.current = event.pointerType === 'touch';
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    // Solo il focus da tastiera: il mouse e il tocco hanno il loro suggerimento.
    if (isKeyboardFocus()) showTipOn(event.currentTarget, tip);
  };
  const onClick = (event: MouseEvent<HTMLElement>) => {
    activateTip(event.currentTarget, tip, action, touching.current);
  };

  const common = {
    'aria-label': label ?? tipText(tip),
    className: `stats-hit ${actionable ? '' : 'stats-tip-only'} ${className}`,
    onPointerEnter,
    onPointerMove,
    onPointerDown,
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch') hideTip(event.currentTarget);
    },
    onFocus,
    onBlur: (event: FocusEvent<HTMLElement>) => {
      // Sul tocco il riquadro con il pulsante deve restare: lo chiude il tocco fuori.
      if (!touching.current) hideTip(event.currentTarget);
    },
    onClick,
  };
  if (!actionable) {
    return (
      <span role="img" tabIndex={focusable ? 0 : undefined} {...common} {...(rest as object)}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" tabIndex={focusable ? undefined : -1} {...common} {...rest}>
      {children}
    </button>
  );
}

/* --- «Mostra dati» --- */

export function DataToggle({ table, onToggle }: { table: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={table}
      className="min-h-8 shrink-0 rounded-full border border-ink-700 bg-white px-3 text-[12px] font-medium text-ink-200 transition hover:bg-ink-800 max-sm:min-h-10"
    >
      {table ? 'Mostra grafico' : 'Mostra dati'}
    </button>
  );
}

/** Stato «grafico o tabella» di un grafico, in memoria. */
export function useDataView(): [boolean, () => void] {
  const [table, setTable] = useState(false);
  return [table, () => setTable((value) => !value)];
}

export interface DataRow {
  key: string;
  /** Primo valore: l'intestazione della riga; gli altri sono numeri o testi brevi. */
  label: string;
  cells: (string | number)[];
  list?: ListSpec;
  book?: { id: string; tab?: 'highlights' };
}

/** Tabella accessibile con le stesse cifre del grafico; le righe con opere si aprono al clic. */
export function DataTable({
  caption,
  head,
  rows,
  tall = false,
}: {
  caption: string;
  /** Intestazioni: la prima della colonna delle righe, poi una per cella. */
  head: string[];
  rows: DataRow[];
  /** Tabelle lunghe (il calendario): altezza limitata con scorrimento. */
  tall?: boolean;
}) {
  const { openList, openBook } = useStatsUi();
  return (
    <div className={`overflow-x-auto ${tall ? 'max-h-[360px] overflow-y-auto' : ''}`}>
      <table className="w-full border-collapse text-[13px] text-ink-100">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-ink-700">
            {head.map((text, index) => (
              <th
                key={text}
                scope="col"
                className={`sticky top-0 bg-white px-2 py-2 text-[12px] font-semibold text-[#6b655a] ${
                  index === 0 ? 'text-left' : 'text-right'
                }`}
              >
                {text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = row.book
              ? () => openBook(row.book!.id, row.book!.tab)
              : row.list && row.list.ids.length > 0
                ? () => openList(row.list!)
                : null;
            return (
              <tr
                key={row.key}
                onClick={open ?? undefined}
                className={`border-b border-ink-750 last:border-b-0 ${open ? 'cursor-pointer hover:bg-ink-800' : ''}`}
              >
                <th scope="row" className="px-2 py-1 text-left font-normal">
                  {open ? (
                    <button
                      type="button"
                      className="min-h-10 text-left text-accent-700 underline-offset-2 hover:underline sm:min-h-8"
                    >
                      {row.label}
                    </button>
                  ) : (
                    <span className="inline-block py-1.5">{row.label}</span>
                  )}
                </th>
                {row.cells.map((cell, index) => (
                  <td key={index} className="px-2 py-1 text-right tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
