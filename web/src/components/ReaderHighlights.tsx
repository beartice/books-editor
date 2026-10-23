import { useState } from 'react';
import { cn } from '../utils';
import { BAR_HEIGHT, CloseIcon, ReaderButton } from './ReaderParts';
import type { ReaderTheme, ReaderThemeName } from './ReaderParts';
import type { BookHighlight, HighlightColor } from '@shared/types';

/* Sottolineature nel lettore EPUB: colori, disegno nel testo, menu e pannello. */

/** Tinte della scheda Sottolineature (HighlightsTab), come esadecimali per l'SVG di epub.js. */
const TINTS: Record<HighlightColor, { hex: string; label: string }> = {
  yellow: { hex: '#fbbf24', label: 'Giallo' },
  green: { hex: '#34d399', label: 'Verde' },
  blue: { hex: '#38bdf8', label: 'Blu' },
  pink: { hex: '#fb7185', label: 'Rosa' },
  purple: { hex: '#a78bfa', label: 'Viola' },
  underline: { hex: '#8a8372', label: 'Sottolineato' },
  none: { hex: '#8a8372', label: 'Senza colore' },
};

/** Colori che si possono scegliere nel menu (`none` esiste solo per le note di Apple Books). */
export const PICKABLE_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'purple', 'underline'];

export function tintOf(color: HighlightColor): string {
  return (TINTS[color] ?? TINTS.none).hex;
}

/** Attributi SVG del segno nel testo: opacita' e fusione adatte al tema. */
export function markStyle(color: HighlightColor, theme: ReaderThemeName, text: string) {
  const dark = theme === 'dark';
  if (color === 'underline') {
    return { kind: 'underline' as const, attrs: { stroke: dark ? text : tintOf(color), 'stroke-opacity': '0.8', 'stroke-width': '1.5', 'mix-blend-mode': 'normal' } };
  }
  const opacity = color === 'none' ? '0.15' : dark ? '0.32' : theme === 'sepia' ? '0.42' : '0.38';
  // Su sfondo scuro «multiply» annerirebbe il testo: si sovrappone normalmente.
  return { kind: 'highlight' as const, attrs: { fill: tintOf(color), 'fill-opacity': opacity, 'mix-blend-mode': dark ? 'normal' : 'multiply' } };
}

/** Il pallino di un colore, anche nel menu. */
function Dot({ color, selected, size = 28 }: { color: HighlightColor; selected?: boolean; size?: number }) {
  return (
    <span
      className={cn(
        'flex items-center justify-center rounded-full border border-black/20',
        selected && 'ring-2 ring-accent-500 ring-offset-1',
      )}
      style={{ width: size, height: size, background: color === 'underline' ? 'transparent' : tintOf(color) }}
    >
      {color === 'underline' && <span className="text-[13px] font-semibold underline">S</span>}
    </span>
  );
}

export type HighlightMenuState =
  | { kind: 'new'; cfi: string; text: string; chapter: string; rect: MenuRect | null }
  | { kind: 'edit'; id: string; rect: MenuRect | null };

/** Rettangolo della selezione o della sottolineatura, in coordinate della finestra. */
export interface MenuRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface MenuProps {
  theme: ReaderTheme;
  state: HighlightMenuState;
  /** Sottolineatura in modifica (solo per `edit`). */
  highlight: BookHighlight | null;
  /** Barra in basso (touch) invece del menu vicino al testo. */
  sheet: boolean;
  /** Nota in scrittura per una nuova sottolineatura; null = campo chiuso. */
  draft: string | null;
  onDraft: (note: string | null) => void;
  error: string;
  onCreate: (color: HighlightColor, note: string) => void;
  onCopy: () => void;
  onColor: (color: HighlightColor) => void;
  onNote: (note: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** Menu per una nuova selezione o per una sottolineatura toccata. Testo e note sono sempre testo, mai HTML. */
export function HighlightMenu(props: MenuProps) {
  const { theme, state, highlight, sheet, draft, onDraft, error, onCreate, onCopy, onColor, onNote, onDelete, onClose } = props;
  const [color, setColor] = useState<HighlightColor>('yellow');
  const [note, setNote] = useState(highlight?.note ?? '');
  const apple = state.kind === 'edit' && highlight?.source === 'applebooks';

  const box = {
    background: theme.panel,
    borderColor: theme.border,
    color: theme.text,
  };
  let position: React.CSSProperties;
  if (sheet) {
    position = { left: 0, right: 0, bottom: 0, paddingBottom: 'env(safe-area-inset-bottom)', borderTopWidth: 1 };
  } else {
    const rect = state.rect;
    const width = 300;
    const left = rect ? Math.max(8, Math.min(window.innerWidth - width - 8, (rect.left + rect.right) / 2 - width / 2)) : 8;
    const below = rect ? rect.top < 200 : false;
    position = {
      left,
      width,
      ...(rect ? (below ? { top: rect.bottom + 10 } : { bottom: window.innerHeight - rect.top + 10 }) : { top: BAR_HEIGHT + 8 }),
      borderWidth: 1,
      borderRadius: 16,
    };
  }

  const colors = (
    <div className="flex items-center justify-between gap-1">
      {PICKABLE_COLORS.map((item) => (
        <button
          key={item}
          type="button"
          aria-label={TINTS[item].label}
          title={TINTS[item].label}
          onClick={() => {
            if (state.kind === 'edit') onColor(item);
            else if (draft !== null) setColor(item);
            else onCreate(item, '');
          }}
          className="flex h-10 w-10 items-center justify-center"
        >
          <Dot color={item} selected={state.kind === 'edit' ? highlight?.color === item : draft !== null && color === item} />
        </button>
      ))}
    </div>
  );

  return (
    <div
      className="absolute z-30 p-2 shadow-panel"
      style={{ ...box, ...position }}
      // Toccare il menu non deve mai arrivare alla pagina sotto.
      onClick={(event) => event.stopPropagation()}
      // I pulsanti non tolgono la selezione dell'iframe (Safari); il campo nota deve poter prendere il focus.
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).tagName !== 'TEXTAREA') event.preventDefault();
      }}
      role="dialog"
      aria-label="Sottolineatura"
    >
      {state.kind === 'edit' && highlight && (
        <p className="mb-1 line-clamp-3 whitespace-pre-wrap px-1 text-[12px] italic" style={{ color: theme.muted }}>
          {highlight.text}
        </p>
      )}
      {apple ? (
        <>
          {highlight?.note && <p className="mb-1 whitespace-pre-wrap px-1 text-[13px]">{highlight.note}</p>}
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[11px]" style={{ color: theme.muted }}>
              Modificabile in Apple Books
            </span>
            <ReaderButton onClick={onClose} aria-label="Chiudi">
              <CloseIcon />
            </ReaderButton>
          </div>
        </>
      ) : (
        <>
          {colors}
          {(state.kind === 'edit' || draft !== null) && (
            <textarea
              value={state.kind === 'edit' ? note : draft ?? ''}
              onChange={(event) => (state.kind === 'edit' ? setNote(event.target.value) : onDraft(event.target.value))}
              placeholder="Nota…"
              maxLength={10000}
              rows={3}
              // 16px: sotto questa soglia Safari su iPhone ingrandisce la pagina al focus.
              className="mt-1 w-full resize-none rounded-lg border bg-transparent p-2 text-[16px]"
              style={{ borderColor: theme.border }}
            />
          )}
          <div className="mt-1 flex items-center gap-1">
            {state.kind === 'new' ? (
              <>
                {draft === null ? (
                  <ReaderButton onClick={() => onDraft('')} className="border" style={{ borderColor: theme.border }}>
                    Nota
                  </ReaderButton>
                ) : (
                  <ReaderButton onClick={() => onCreate(color, draft)} className="border" style={{ borderColor: theme.border }}>
                    Salva
                  </ReaderButton>
                )}
                <ReaderButton onClick={onCopy} className="border" style={{ borderColor: theme.border }}>
                  Copia
                </ReaderButton>
              </>
            ) : (
              <>
                <ReaderButton onClick={() => onNote(note)} className="border" style={{ borderColor: theme.border }}>
                  Salva nota
                </ReaderButton>
                <ReaderButton onClick={onDelete} className="border text-rose-600" style={{ borderColor: theme.border }}>
                  Elimina
                </ReaderButton>
              </>
            )}
            <span className="flex-1" />
            <ReaderButton onClick={onClose} aria-label="Chiudi">
              <CloseIcon />
            </ReaderButton>
          </div>
        </>
      )}
      {error && <p className="px-1 pt-1 text-[12px] text-rose-600">{error}</p>}
    </div>
  );
}

interface PanelProps {
  theme: ReaderTheme;
  highlights: BookHighlight[];
  safeTop: string;
  safeBottom: string;
  onGo: (highlight: BookHighlight) => void;
  onClose: () => void;
}

/** Elenco delle sottolineature del file aperto: il tocco porta al punto. */
export function HighlightsPanel({ theme, highlights, safeTop, safeBottom, onGo, onClose }: PanelProps) {
  return (
    <div className="absolute inset-0 z-20 flex" onClick={onClose}>
      <nav
        className="flex h-full w-80 max-w-[90%] flex-col border-r shadow-panel"
        style={{ background: theme.panel, borderColor: theme.border, color: theme.text }}
        onClick={(event) => event.stopPropagation()}
        aria-label="Sottolineature"
      >
        <div
          className="flex items-center justify-between border-b px-3"
          style={{ borderColor: theme.border, paddingTop: safeTop, height: `calc(${BAR_HEIGHT}px + ${safeTop})` }}
        >
          <span className="text-[14px] font-semibold">Sottolineature ({highlights.length})</span>
          <ReaderButton onClick={onClose} aria-label="Chiudi le sottolineature">
            <CloseIcon />
          </ReaderButton>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" style={{ paddingBottom: safeBottom }}>
          {highlights.length === 0 && (
            <li className="px-4 py-6 text-center text-[13px]" style={{ color: theme.muted }}>
              Nessuna sottolineatura. Seleziona del testo per crearne una.
            </li>
          )}
          {highlights.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onGo(item)}
                className="block min-h-[2.5rem] w-full px-4 py-2 text-left hover:bg-black/[0.06]"
              >
                <span className="flex items-center gap-2 text-[11px]" style={{ color: theme.muted }}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tintOf(item.color) }} />
                  <span className="truncate">{item.chapter || 'Senza capitolo'}</span>
                </span>
                <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap text-[13px] leading-snug">{item.text}</span>
                {item.note && (
                  <span className="mt-1 line-clamp-2 block whitespace-pre-wrap text-[12px] italic" style={{ color: theme.muted }}>
                    {item.note}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
