import { useMemo, useState } from 'react';
import { describeFilter, libraryNameOf, matchesQuickFilter, useStore } from '../store';
import type { Filters, QuickFilter } from '../store';
import { cn, formatNumber } from '../utils';
import { READING_STATUSES, isFanficUpdateAvailable } from '@shared/types';
import {
  IconBook,
  IconBookmark,
  IconChart,
  IconChevron,
  IconClose,
  IconFilter,
  IconGrid,
  IconHeart,
  IconHome,
  IconLayers,
  IconRefresh,
  IconSettings,
  IconSparkle,
  IconStar,
  IconLogout,
} from './icons';
import LibrariesSection from './LibrariesSection';

interface Props {
  onOpenSettings: () => void;
  onOpenSeries: () => void;
  onOpenStats: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-black/[0.05] py-2.5">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500 transition hover:text-ink-200"
      >
        {title}
        <IconChevron
          className={cn('h-3 w-3 transition-transform', open ? 'rotate-90' : 'rotate-0')}
        />
      </button>
      {open && <div className="mt-1 space-y-0.5">{children}</div>}
    </div>
  );
}

function FilterRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition',
        active
          ? 'bg-accent-500/10 font-medium text-accent-700'
          : 'text-ink-400 hover:bg-black/[0.035] hover:text-ink-100',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-500">{count}</span>
    </button>
  );
}

export default function Sidebar({
  onOpenSettings,
  onOpenSeries,
  onOpenStats,
  mobileOpen,
  onClose,
}: Props) {
  const {
    authEnabled,
    logout,
    books,
    stats,
    filters,
    toggleFilter,
    setFlagFilter,
    setQuickFilter,
    clearFilters,
  } = useStore();

  const facets = useMemo(() => {
    const count = (values: string[]) => {
      const map = new Map<string, number>();
      for (const value of values) {
        if (!value) continue;
        map.set(value, (map.get(value) ?? 0) + 1);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    };
    return {
      authors: count(books.flatMap((book) => book.authors)),
      fandoms: count(books.map((book) => book.fandom)),
      series: count(books.map((book) => book.series)),
      tags: count(books.flatMap((book) => book.tags)),
      formats: count(books.map((book) => book.format)),
    };
  }, [books]);

  const activeCount = Object.values(filters).reduce(
    (total, value) => total + (Array.isArray(value) ? value.length : value ? 1 : 0),
    0,
  );

  const toggle = (group: keyof Filters, value: string) => toggleFilter(group, value);

  const navigate = (quick: QuickFilter) => {
    setQuickFilter(quick);
    onClose();
    window.setTimeout(() => {
      if (quick === 'all') {
        document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        document.getElementById('library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 60);
  };

  const scrollToCategories = () => {
    onClose();
    window.setTimeout(() => {
      document.getElementById('categories')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  // Fanfiction con nuovi capitoli sul sito: la voce compare solo se ce n'e' almeno una.
  const updatesCount = useMemo(
    () => books.filter((book) => isFanficUpdateAvailable(book.fanficUpdate)).length,
    [books],
  );

  const navItems: Array<{
    quick: QuickFilter;
    label: string;
    icon: typeof IconBook;
    count?: number;
  }> = [
    { quick: 'all', label: 'Scopri', icon: IconHome },
    { quick: 'books', label: 'Libri', icon: IconBook },
    { quick: 'fanfic', label: 'Fanfiction', icon: IconSparkle },
    { quick: 'favorites', label: 'Preferiti', icon: IconHeart },
    { quick: 'unread', label: 'Da leggere', icon: IconBookmark },
    ...(updatesCount > 0
      ? [{ quick: 'updates' as const, label: 'Aggiornamenti', icon: IconRefresh, count: updatesCount }]
      : []),
  ];

  const libraryName = useStore(libraryNameOf);

  return (
    <>
      <div
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 bg-ink-950/25 backdrop-blur-[2px] transition-opacity duration-300 lg:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[292px] shrink-0 flex-col bg-white px-4 pb-4 pt-5 shadow-panel transition-transform duration-300',
          'lg:static lg:z-auto lg:h-full lg:w-[272px] lg:translate-x-0 lg:rounded-none lg:border-r lg:border-black/[0.05] lg:px-4 lg:shadow-none',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-3 px-1">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-coral-500 text-white shadow-sm">
            <IconBook className="h-[19px] w-[19px]" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-bold uppercase tracking-[0.2em] text-ink-50">
              The Books
            </p>
            <p className="mt-0.5 truncate text-[10px] text-ink-500">{libraryName}</p>
          </div>
          <button
            onClick={onClose}
            className="btn-subtle ml-auto h-10 w-10 shrink-0 px-0 lg:hidden"
            aria-label="Chiudi filtri"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
          <LibrariesSection onClose={onClose} />
          <p className="px-2.5 text-[9px] font-semibold uppercase tracking-[0.2em] text-ink-500">
            Menu
          </p>
          <nav className="mt-2 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = matchesQuickFilter(filters, item.quick);
              return (
                <button
                  key={item.quick}
                  onClick={() => navigate(item.quick)}
                  className={cn(
                    'group flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition',
                    active ? 'bg-[#f7f2e8]' : 'hover:bg-black/[0.025]',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition',
                      active
                        ? 'bg-coral-500 text-white shadow-sm'
                        : 'bg-ink-800 text-ink-400 group-hover:bg-ink-750 group-hover:text-ink-200',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span
                    className={cn(
                      'text-[12.5px]',
                      active ? 'font-semibold text-ink-100' : 'font-medium text-ink-400',
                    )}
                  >
                    {item.label}
                  </span>
                  {item.count != null && (
                    <span className="ml-auto rounded-full bg-coral-500 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-white">
                      {item.count}
                    </span>
                  )}
                  {item.count == null && active && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-coral-500" />
                  )}
                </button>
              );
            })}

            <button
              onClick={scrollToCategories}
              className="group flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-black/[0.025]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-ink-800 text-ink-400 transition group-hover:bg-ink-750 group-hover:text-ink-200">
                <IconGrid className="h-4 w-4" />
              </span>
              <span className="text-[12.5px] font-medium text-ink-400">Categorie</span>
            </button>

            <button
              onClick={() => {
                onClose();
                onOpenSeries();
              }}
              className="group flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-black/[0.025]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-ink-800 text-ink-400 transition group-hover:bg-ink-750 group-hover:text-ink-200">
                <IconLayers className="h-4 w-4" />
              </span>
              <span className="text-[12.5px] font-medium text-ink-400">Serie</span>
              {facets.series.length > 0 && (
                <span className="ml-auto text-[10px] tabular-nums text-ink-500">
                  {facets.series.length}
                </span>
              )}
            </button>

            <button
              onClick={() => {
                onClose();
                onOpenStats();
              }}
              className="group flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-black/[0.025]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-ink-800 text-ink-400 transition group-hover:bg-ink-750 group-hover:text-ink-200">
                <IconChart className="h-4 w-4" />
              </span>
              <span className="text-[12.5px] font-medium text-ink-400">Statistiche</span>
            </button>
          </nav>

          <div className="mt-6 flex items-center justify-between px-2">
            <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-ink-500">
              Filtri
            </p>
            {activeCount > 0 && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 text-[10px] font-medium text-coral-600 transition hover:text-coral-700"
              >
                Azzera ({activeCount})
              </button>
            )}
          </div>

          <div className="mt-1">
            <Section title="Tipo">
              {(['book', 'fanfic'] as const).map((kind) => (
                <FilterRow
                  key={kind}
                  label={describeFilter('kinds', kind)}
                  count={books.filter((book) => book.kind === kind).length}
                  active={filters.kinds.includes(kind)}
                  onClick={() => toggle('kinds', kind)}
                />
              ))}
            </Section>

            <Section title="Formato">
              {facets.formats.map(([format, count]) => (
                <FilterRow
                  key={format}
                  label={describeFilter('formats', format)}
                  count={count}
                  active={filters.formats.includes(format)}
                  onClick={() => toggle('formats', format)}
                />
              ))}
            </Section>

            <Section title="Lettura" defaultOpen={false}>
              {READING_STATUSES.map((status) => (
                <FilterRow
                  key={status}
                  label={describeFilter('readingStatus', status)}
                  count={books.filter((book) => book.readingStatus === status).length}
                  active={filters.readingStatus.includes(status)}
                  onClick={() => toggle('readingStatus', status)}
                />
              ))}
            </Section>

            <Section title="Autore" defaultOpen={false}>
              {facets.authors.slice(0, 40).map(([author, count]) => (
                <FilterRow
                  key={author}
                  label={author}
                  count={count}
                  active={filters.authors.includes(author)}
                  onClick={() => toggle('authors', author)}
                />
              ))}
            </Section>

            {facets.fandoms.length > 0 && (
              <Section title="Fandom" defaultOpen={false}>
                {facets.fandoms.slice(0, 30).map(([fandom, count]) => (
                  <FilterRow
                    key={fandom}
                    label={fandom}
                    count={count}
                    active={filters.fandoms.includes(fandom)}
                    onClick={() => toggle('fandoms', fandom)}
                  />
                ))}
              </Section>
            )}

            {facets.series.length > 0 && (
              <Section title="Serie" defaultOpen={false}>
                {facets.series.slice(0, 30).map(([series, count]) => (
                  <FilterRow
                    key={series}
                    label={series}
                    count={count}
                    active={filters.series.includes(series)}
                    onClick={() => toggle('series', series)}
                  />
                ))}
              </Section>
            )}

            {facets.tags.length > 0 && (
              <Section title="Tag" defaultOpen={false}>
                {facets.tags.slice(0, 40).map(([tag, count]) => (
                  <FilterRow
                    key={tag}
                    label={tag}
                    count={count}
                    active={filters.tags.includes(tag)}
                    onClick={() => toggle('tags', tag)}
                  />
                ))}
              </Section>
            )}

            <Section title="Scarti rapidi" defaultOpen={false}>
              <button
                onClick={() => setFlagFilter('favoritesOnly', !filters.favoritesOnly)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition',
                  filters.favoritesOnly
                    ? 'bg-accent-500/10 font-medium text-accent-700'
                    : 'text-ink-400 hover:bg-black/[0.035] hover:text-ink-100',
                )}
              >
                <IconHeart className="h-3.5 w-3.5" />
                Solo preferiti
                <span className="ml-auto text-[10px] tabular-nums text-ink-500">
                  {books.filter((book) => book.favorite).length}
                </span>
              </button>
              <button
                onClick={() => setFlagFilter('missingCover', !filters.missingCover)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition',
                  filters.missingCover
                    ? 'bg-accent-500/10 font-medium text-accent-700'
                    : 'text-ink-400 hover:bg-black/[0.035] hover:text-ink-100',
                )}
              >
                <IconStar className="h-3.5 w-3.5" />
                Senza copertina
                <span className="ml-auto text-[10px] tabular-nums text-ink-500">
                  {books.filter((book) => !book.coverFile).length}
                </span>
              </button>
              <button
                onClick={() => setFlagFilter('missingMetadata', !filters.missingMetadata)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition',
                  filters.missingMetadata
                    ? 'bg-accent-500/10 font-medium text-accent-700'
                    : 'text-ink-400 hover:bg-black/[0.035] hover:text-ink-100',
                )}
              >
                <IconFilter className="h-3.5 w-3.5" />
                Metadati incompleti
                <span className="ml-auto text-[10px] tabular-nums text-ink-500">
                  {books.filter((book) => !book.authors.length || !book.description).length}
                </span>
              </button>
            </Section>
          </div>

        </div>

        <div className="mt-3 shrink-0">
          <LibraryCard
            total={stats?.total ?? books.length}
            words={stats?.words ?? 0}
            books={stats?.books ?? 0}
            fanfics={stats?.fanfics ?? 0}
          />
        </div>

        <div className="mt-3 border-t border-black/[0.06] pt-3">
          <button
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
            className="btn-ghost w-full justify-start px-3 text-[12px] text-ink-400"
          >
            <IconSettings className="h-4 w-4" />
            Impostazioni libreria
          </button>
          {authEnabled && (
            <button
              onClick={() => {
                onClose();
                logout();
              }}
              className="btn-ghost mt-1 w-full justify-start px-3 text-[12px] text-ink-400"
            >
              <IconLogout className="h-4 w-4" />
              Esci
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

function LibraryCard({
  total,
  words,
  books,
  fanfics,
}: {
  total: number;
  words: number;
  books: number;
  fanfics: number;
}) {
  const libraryName = useStore(libraryNameOf);
  return (
    <div className="relative overflow-hidden rounded-[22px] bg-[#f1e5d9] p-4">
      <span className="pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full bg-white/40" />
      <span className="pointer-events-none absolute -bottom-8 left-14 h-24 w-24 rounded-full bg-coral-200/40 blur-sm" />

      <div className="relative flex items-center gap-4">
        <div className="relative h-16 w-[68px] shrink-0">
          <span className="absolute bottom-0 left-0 h-12 w-8 rotate-[-10deg] rounded-[3px] bg-coral-400 shadow-sm" />
          <span className="absolute bottom-0 left-[19px] h-[60px] w-[34px] rotate-[2deg] rounded-[3px] bg-accent-600 shadow-md" />
          <span className="absolute bottom-0 left-[50px] h-12 w-7 rotate-[12deg] rounded-[3px] bg-white shadow-sm" />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-500">
            {libraryName}
          </p>
          <p className="mt-0.5 text-[19px] font-semibold leading-none text-ink-100">
            {formatNumber(total)}
            <span className="ml-1 text-[10px] font-normal text-ink-500">
              {total === 1 ? 'opera' : 'opere'}
            </span>
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-500">
            {formatNumber(words)} parole · {books} {books === 1 ? 'libro' : 'libri'} · {fanfics}{' '}
            fanfic
          </p>
        </div>
      </div>
    </div>
  );
}
