import { useEffect, useMemo, useRef } from 'react';
import { hideFanficsOf, libraryNameOf, useStore } from '../store';
import type { QuickFilter } from '../store';
import { SORT_LABELS, cn, initials } from '../utils';
import type { SortKey } from '@shared/types';
import {
  IconChevron,
  IconClose,
  IconFilter,
  IconGrid,
  IconList,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
} from './icons';

interface Props {
  onOpenImport: () => void;
  onOpenSettings: () => void;
  onOpenFilters: () => void;
  visibleCount: number;
}

function categoryFromFilters(filters: ReturnType<typeof useStore.getState>['filters']): QuickFilter {
  if (filters.favoritesOnly) return 'favorites';
  if (filters.kinds.length === 1 && filters.kinds[0] === 'book') return 'books';
  if (filters.kinds.length === 1 && filters.kinds[0] === 'fanfic') return 'fanfic';
  return 'all';
}

export default function TopBar({
  onOpenImport,
  onOpenSettings,
  onOpenFilters,
  visibleCount,
}: Props) {
  const {
    query,
    setQuery,
    sort,
    setSort,
    view,
    setView,
    scan,
    busy,
    filters,
    setQuickFilter,
    clearFilters,
  } = useStore();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const libraryName = useStore(libraryNameOf);
  const hideFanfics = useStore(hideFanficsOf);
  const libraryInitials = initials(libraryName) || 'LM';
  const category = categoryFromFilters(filters);

  const activeFilterCount = useMemo(
    () =>
      Object.values(filters).reduce<number>(
        (total, value) => total + (Array.isArray(value) ? value.length : value ? 1 : 0),
        0,
      ),
    [filters],
  );

  const submitSearch = () => {
    searchRef.current?.focus();
    document.getElementById('library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <header className="relative overflow-hidden bg-[#e9e4d6] px-4 pb-12 pt-3 sm:px-7 sm:pb-20 sm:pt-4 lg:px-10 lg:pb-24 lg:pt-6">
      <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/35 blur-3xl" />
      <div className="pointer-events-none absolute right-28 top-36 h-48 w-48 rounded-full border border-white/40" />
      <div className="pointer-events-none absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-[#f7f0e4]/50 blur-3xl" />

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenFilters}
            className="btn-ghost h-10 px-3 lg:hidden"
            aria-label="Apri i filtri"
          >
            <IconFilter className="h-4 w-4" />
            <span className="text-xs">Filtri</span>
          </button>
          <p className="hidden text-[10px] font-semibold uppercase tracking-[0.22em] text-ink-500 lg:block">
            Archivio personale
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={scan}
            disabled={busy}
            className="btn-ghost h-10 px-2.5 sm:px-3.5"
            title="Scansiona la cartella"
          >
            <IconRefresh className={cn('h-4 w-4', busy && 'animate-spin')} />
            <span className="hidden text-xs md:inline">Scansiona</span>
          </button>

          <button onClick={onOpenImport} className="btn-primary h-10 px-3 sm:px-4">
            <IconPlus className="h-4 w-4" />
            <span className="hidden text-xs sm:inline">Importa</span>
          </button>

          <button
            onClick={onOpenSettings}
            className="btn-ghost hidden h-10 w-10 px-0 sm:inline-flex"
            title="Impostazioni"
            aria-label="Impostazioni"
          >
            <IconSettings className="h-4 w-4" />
          </button>

          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-full border border-black/[0.06] bg-white/85 py-1.5 pl-1.5 pr-2.5 text-left shadow-sm backdrop-blur transition hover:bg-white"
            title="Impostazioni libreria"
            aria-label="Apri le impostazioni della libreria"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-coral-400 to-coral-600 text-[10px] font-bold tracking-wide text-white">
              {libraryInitials}
            </span>
            <span className="hidden min-w-0 sm:block">
              <span className="block max-w-[150px] truncate text-[12px] font-semibold text-ink-100">
                {libraryName}
              </span>
              <span className="block text-[10px] text-ink-500">
                {visibleCount === 1 ? '1 opera visibile' : `${visibleCount} opere visibili`}
              </span>
            </span>
            <IconChevron className="hidden h-3.5 w-3.5 rotate-90 text-ink-400 sm:block" />
          </button>
        </div>
      </div>

      <div className="relative mt-3 max-w-[1100px] sm:mt-8 lg:mt-10">
        <p className="eyebrow text-ink-500">La tua prossima storia</p>
        <h1 className="mt-1 text-[30px] font-semibold leading-none tracking-[-0.045em] text-ink-50 sm:mt-1.5 sm:text-[52px] lg:text-[58px]">
          Scopri
        </h1>
        <p className="mt-3 hidden max-w-lg text-[13px] leading-relaxed text-ink-400 sm:block sm:text-sm">
          Cerca, organizza e ritrova ogni storia del tuo archivio personale.
        </p>

        <div className="mt-3 flex flex-col gap-0.5 rounded-[20px] border border-black/[0.04] bg-white p-2 shadow-soft sm:flex-row sm:items-center sm:gap-0">
          <div className="flex items-center gap-2 rounded-xl px-3 py-2 sm:w-[205px] sm:border-r sm:border-black/[0.06]">
            <IconFilter className="h-4 w-4 shrink-0 text-ink-400" />
            <select
              value={category}
              onChange={(event) => setQuickFilter(event.target.value as QuickFilter)}
              className="w-full cursor-pointer appearance-none bg-transparent text-[12px] font-medium text-ink-300 outline-none"
              aria-label="Categoria"
            >
              <option value="all">Tutte le categorie</option>
              <option value="books">Libri</option>
              {!hideFanfics && <option value="fanfic">Fanfiction</option>}
              <option value="favorites">Preferiti</option>
            </select>
            <IconChevron className="h-3.5 w-3.5 shrink-0 rotate-90 text-ink-500" />
          </div>

          <div className="relative min-w-0 flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitSearch();
              }}
              placeholder="Cerca per titolo, autore, fandom..."
              className="h-11 w-full rounded-xl border-0 bg-transparent pl-9 pr-9 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:ring-0"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-400 transition hover:bg-black/[0.05] hover:text-ink-100"
                aria-label="Cancella ricerca"
              >
                <IconClose className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            onClick={submitSearch}
            className="btn-primary hidden h-11 shrink-0 rounded-[13px] px-5 text-[12px] sm:inline-flex"
          >
            <IconSearch className="h-4 w-4" />
            Cerca
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 sm:mt-4 sm:gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white/55 px-2.5 py-1 text-[11px] font-medium text-ink-400">
              {visibleCount === 1 ? '1 opera' : `${visibleCount} opere`}
            </span>
            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-1 text-[11px] font-medium text-ink-400 transition hover:bg-white hover:text-ink-100"
              >
                Filtri attivi · {activeFilterCount}
                <IconClose className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl border border-black/[0.06] bg-white/80 p-0.5 shadow-sm">
              <span className="hidden pl-2 text-[9px] font-medium uppercase tracking-[0.12em] text-ink-500 sm:inline">
                Ordina
              </span>
              <select
                value={sort.key}
                onChange={(event) => setSort(event.target.value as SortKey)}
                className="cursor-pointer appearance-none bg-transparent py-1.5 pl-1 pr-1 text-[11px] font-medium text-ink-300 outline-none sm:pl-0.5"
                aria-label="Ordina per"
              >
                {Object.entries(SORT_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setSort(sort.key)}
                className="flex h-7 w-6 items-center justify-center rounded-lg text-ink-400 transition hover:bg-black/[0.05] hover:text-ink-100"
                title={sort.asc ? 'Ordine crescente' : 'Ordine decrescente'}
                aria-label={sort.asc ? 'Ordine crescente' : 'Ordine decrescente'}
              >
                <IconChevron
                  className={cn('h-3.5 w-3.5', sort.asc ? '-rotate-90' : 'rotate-90')}
                />
              </button>
            </div>

            <div className="flex items-center rounded-xl border border-black/[0.06] bg-white/80 p-0.5 shadow-sm">
              <button
                onClick={() => setView('grid')}
                aria-label="Vista griglia"
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-[9px] transition',
                  view === 'grid'
                    ? 'bg-accent-600 text-white shadow-sm'
                    : 'text-ink-400 hover:bg-black/[0.05] hover:text-ink-100',
                )}
              >
                <IconGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView('list')}
                aria-label="Vista elenco"
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-[9px] transition',
                  view === 'list'
                    ? 'bg-accent-600 text-white shadow-sm'
                    : 'text-ink-400 hover:bg-black/[0.05] hover:text-ink-100',
                )}
              >
                <IconList className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
