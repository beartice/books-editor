import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { ReadingStats } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { IconClose } from './icons';
import StatsDashboard from './StatsDashboard';
import StatsDiary from './StatsDiary';
import StatsYearReview from './StatsYearReview';
import { EmptyNote } from './StatsParts';

interface Props {
  onClose: () => void;
}

type Tab = 'diary' | 'dashboard' | 'year';
type Period = number | 'all';

const TABS: { id: Tab; label: string }[] = [
  { id: 'diary', label: 'Diario' },
  { id: 'dashboard', label: 'Cruscotto' },
  { id: 'year', label: 'Il tuo anno' },
];

const TAB_KEY = 'books-editor.stats-tab';

function readStoredTab(): Tab {
  try {
    const value = window.localStorage.getItem(TAB_KEY);
    if (value === 'diary' || value === 'dashboard' || value === 'year') return value;
  } catch {
    // localStorage non disponibile: si parte dal Diario.
  }
  return 'diary';
}

/** Carica le statistiche del periodo; ricarica se cambia periodo o libreria. */
function useReadingStats(period: Period) {
  const libraryId = useStore((state) => state.libraryId);
  const [data, setData] = useState<ReadingStats | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError('');
    api
      .readingStats(period)
      .then((stats) => {
        if (!cancelled) setData(stats);
      })
      .catch((failure) => {
        if (!cancelled) setError((failure as Error).message || 'Impossibile leggere le statistiche');
      });
    return () => {
      cancelled = true;
    };
  }, [period, libraryId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { data, error, retry };
}

const pillClass = (active: boolean) =>
  `min-h-10 shrink-0 rounded-full px-4 text-[13px] transition ${
    active ? 'bg-accent-600 font-semibold text-white' : 'text-ink-200 hover:bg-black/[0.04]'
  }`;

/**
 * Statistiche a schermo intero: tre viste (Diario, Cruscotto, Il tuo anno) e un solo
 * selettore del periodo. Ha una voce di cronologia propria, come il lettore: «Indietro»,
 * Esc e lo swipe di iOS la chiudono.
 */
export default function StatsView({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>(readStoredTab);
  const [period, setPeriod] = useState<Period>('all');
  const [yearsKnown, setYearsKnown] = useState<number[]>([]);
  const [tipText, setTipText] = useState('');
  const tipTimer = useRef<number>();
  const scroller = useRef<HTMLDivElement>(null);

  // «Il tuo anno» con «Sempre» racconta l'anno in corso.
  const currentYear = new Date().getFullYear();
  const requested: Period = tab === 'year' && period === 'all' ? currentYear : period;
  const { data, error, retry } = useReadingStats(requested);
  const ready = data !== null && data.year === requested ? data : null;

  // Gli anni del selettore arrivano da ogni risposta (sono sempre quelli di tutto il tempo).
  useEffect(() => {
    if (!data) return;
    const years = data.byYear.map((item) => item.year).sort((a, b) => b - a);
    setYearsKnown((previous) => (previous.join() === years.join() ? previous : years));
  }, [data]);

  // Cronologia: una voce per la vista, cosi' «Indietro» la chiude senza uscire dall'app.
  useEffect(() => {
    if (!window.history.state?.stats) window.history.pushState({ stats: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onClose]);

  const close = useCallback(() => {
    if (window.history.state?.stats) window.history.back();
    else onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  // Schermo bloccato sotto la vista: niente scroll della pagina sottostante.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const chooseTab = (next: Tab) => {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      // Non salvata: vale solo per questa apertura.
    }
    scroller.current?.scrollTo({ top: 0 });
  };

  // Su touch non c'e' il passaggio del mouse: il tocco su un elemento mostra lo stesso suggerimento.
  const onTap = (event: MouseEvent) => {
    if (!window.matchMedia('(hover: none)').matches) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    window.clearTimeout(tipTimer.current);
    setTipText(target?.dataset.tip ?? '');
    if (target) tipTimer.current = window.setTimeout(() => setTipText(''), 4000);
  };

  const periods = useMemo<Period[]>(() => ['all', ...yearsKnown], [yearsKnown]);
  const selected = ready?.year ?? requested;
  const isEmpty = ready !== null && ready.tiles.total.total === 0;
  const white = tab === 'dashboard';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Statistiche di lettura"
      className={`fixed inset-0 z-50 flex animate-fade-in flex-col ${white ? 'bg-white' : 'bg-[#f4f0e7]'}`}
      onClick={onTap}
    >
      <div className="shrink-0 border-b border-black/[0.05]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
          <div role="tablist" className="flex gap-1.5 rounded-full border border-ink-700 bg-white p-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => chooseTab(item.id)}
                className={pillClass(tab === item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-1.5 overflow-x-auto px-4 no-scrollbar sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 lg:order-none lg:mx-0 lg:w-auto lg:flex-1 lg:justify-center lg:px-0">
            {periods.map((item) => (
              <button
                key={item}
                onClick={() => setPeriod(item)}
                aria-pressed={period === item}
                className={`${pillClass(period === item)} ${
                  period === item ? '' : 'border border-ink-700 bg-white'
                }`}
              >
                {item === 'all' ? 'Sempre' : item}
              </button>
            ))}
          </div>
          <button
            onClick={close}
            className="btn-subtle ml-auto h-10 w-10 shrink-0 px-0 lg:ml-0"
            aria-label="Chiudi statistiche"
          >
            <IconClose />
          </button>
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
        <div className="mx-auto w-full max-w-[1160px] px-4 pb-20 pt-6 sm:px-6 sm:pt-10">
          {error && !ready ? (
            <div className="flex flex-col items-start gap-3">
              <EmptyNote>{error}</EmptyNote>
              <button onClick={retry} className="btn-ghost min-h-10">
                Riprova
              </button>
            </div>
          ) : !ready ? (
            <p className="py-10 text-center text-sm text-ink-400">Carico le statistiche…</p>
          ) : isEmpty ? (
            <EmptyNote>La libreria è vuota: aggiungi qualche opera per vedere le statistiche.</EmptyNote>
          ) : tab === 'diary' ? (
            <StatsDiary stats={ready} selected={selected} />
          ) : tab === 'dashboard' ? (
            <StatsDashboard stats={ready} selected={selected} />
          ) : (
            <StatsYearReview stats={ready} year={requested as number} />
          )}
        </div>
      </div>

      {tipText && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-4 bottom-4 z-10 mx-auto w-fit max-w-[min(92vw,420px)] rounded-xl bg-ink-100 px-3.5 py-2 text-center text-[13px] text-white shadow-panel"
        >
          {tipText}
        </div>
      )}
    </div>
  );
}
