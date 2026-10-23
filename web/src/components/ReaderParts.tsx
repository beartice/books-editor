import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { cn } from '../utils';
import { IconChevron, IconClose } from './icons';

/* Elementi comuni ai lettori EPUB e PDF: temi, barre e pulsanti. */

export type ReaderThemeName = 'light' | 'sepia' | 'dark';

export interface ReaderTheme {
  label: string;
  /** Sfondo della pagina e del contorno. */
  background: string;
  /** Colore del testo. */
  text: string;
  /** Colore dei testi secondari e dei bordi. */
  muted: string;
  /** Sfondo di barre e pannelli. */
  panel: string;
  border: string;
}

export const READER_THEMES: Record<ReaderThemeName, ReaderTheme> = {
  light: {
    label: 'Chiaro',
    background: '#ffffff',
    text: '#1d1a15',
    muted: '#7b7569',
    panel: 'rgba(255,255,255,0.96)',
    border: 'rgba(0,0,0,0.1)',
  },
  sepia: {
    label: 'Seppia',
    background: '#f4ecd8',
    text: '#4b3b26',
    muted: '#8b7b62',
    panel: 'rgba(244,236,216,0.97)',
    border: 'rgba(75,59,38,0.18)',
  },
  dark: {
    label: 'Scuro',
    background: '#16130f',
    text: '#d9d2c3',
    muted: '#8f8878',
    panel: 'rgba(30,26,21,0.97)',
    border: 'rgba(255,255,255,0.14)',
  },
};

const THEME_KEY = 'books.reader.theme';
const SIZE_KEY = 'books.reader.fontSize';

export function readStoredTheme(): ReaderThemeName {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'sepia' || value === 'dark') return value;
  } catch {
    /* localStorage non disponibile: tema predefinito */
  }
  return 'light';
}

export function storeTheme(name: ReaderThemeName): void {
  try {
    window.localStorage.setItem(THEME_KEY, name);
  } catch {
    /* si perde solo la preferenza */
  }
}

/** Dimensione del testo EPUB in percentuale. */
export const FONT_SIZES = { min: 70, max: 200, step: 10, initial: 100 };

export function readStoredFontSize(): number {
  try {
    const value = Number(window.localStorage.getItem(SIZE_KEY));
    if (Number.isFinite(value) && value >= FONT_SIZES.min && value <= FONT_SIZES.max) return value;
  } catch {
    /* localStorage non disponibile: dimensione predefinita */
  }
  return FONT_SIZES.initial;
}

export function storeFontSize(value: number): void {
  try {
    window.localStorage.setItem(SIZE_KEY, String(value));
  } catch {
    /* si perde solo la preferenza */
  }
}

/** Altezza delle barre in alto e in basso: la pagina lascia sempre questo spazio, cosi' mostrarle non sposta il testo. */
export const BAR_HEIGHT = 52;

export function barStyle(theme: ReaderTheme, edge: 'top' | 'bottom', visible: boolean): CSSProperties {
  const inset = edge === 'top' ? 'paddingTop' : 'paddingBottom';
  const safe = edge === 'top' ? 'env(safe-area-inset-top)' : 'env(safe-area-inset-bottom)';
  return {
    [edge]: 0,
    [inset]: safe,
    background: theme.panel,
    color: theme.text,
    borderColor: theme.border,
    transform: visible ? 'translateY(0)' : `translateY(${edge === 'top' ? '-100%' : '100%'})`,
    opacity: visible ? 1 : 0,
    pointerEvents: visible ? 'auto' : 'none',
    transition: 'transform 0.18s ease, opacity 0.18s ease',
  };
}

/** Pulsante tondo della barra: almeno 40 px per il tocco. */
export function ReaderButton({
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'flex h-10 min-w-[2.5rem] shrink-0 items-center justify-center rounded-full px-2 text-[13px] font-medium',
        'transition hover:bg-black/[0.07] disabled:opacity-35',
        className,
      )}
    >
      {children}
    </button>
  );
}

export const ChevronLeft = () => <IconChevron className="h-5 w-5 rotate-180" />;
export const ChevronRight = () => <IconChevron className="h-5 w-5" />;
export const CloseIcon = () => <IconClose className="h-5 w-5" />;

/** Stato a tutto schermo: caricamento (con percentuale) oppure errore con pulsante per chiudere. */
export function ReaderMessage({
  theme,
  title,
  detail,
  progress,
  error,
  onClose,
}: {
  theme: ReaderTheme;
  title: string;
  detail?: string;
  /** Percentuale del download; null se non nota; assente = nessuna barra. */
  progress?: number | null;
  error?: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-4 px-8 text-center"
      style={{ background: theme.background, color: theme.text }}
    >
      <p className="max-w-sm text-[15px] font-medium">{title}</p>
      {detail && (
        <p className="max-w-sm text-[13px]" style={{ color: theme.muted }}>
          {detail}
        </p>
      )}
      {progress !== undefined && (
        <div
          className="h-1.5 w-56 overflow-hidden rounded-full"
          style={{ background: theme.border }}
          role="progressbar"
          aria-valuenow={progress ?? undefined}
        >
          <div
            className={cn('h-full rounded-full bg-accent-500', progress === null && 'w-1/3 animate-pulse')}
            style={progress === null ? undefined : { width: `${Math.round(progress)}%` }}
          />
        </div>
      )}
      <button type="button" onClick={onClose} className={error ? 'btn-primary' : 'btn-ghost'}>
        {error ? 'Chiudi' : 'Annulla'}
      </button>
    </div>
  );
}
