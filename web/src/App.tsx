import { useEffect, useMemo, useState } from 'react';
import { matchesQuickFilter, selectVisible, useStore } from './store';
import type { QuickFilter } from './store';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import BookCard from './components/BookCard';
import BookList from './components/BookList';
import Pagination from './components/Pagination';
import DetailPanel from './components/DetailPanel';
import ImportDialog from './components/ImportDialog';
import SettingsDialog from './components/SettingsDialog';
import SeriesDialog from './components/SeriesDialog';
import StatsDialog from './components/StatsDialog';
import LoginPage from './components/LoginPage';
import SetupPage from './components/SetupPage';
import Toasts from './components/Toasts';
import BookCover from './components/BookCover';
import {
  IconBook,
  IconBookmark,
  IconChevron,
  IconHeart,
  IconLayers,
  IconPlus,
} from './components/icons';
import { cn } from './utils';
import type { BookSummary } from '@shared/types';

// Opere per pagina: divisibile per 2, 3, 4, 5 e 6 (colonne della griglia).
const PAGE_SIZE = 60;

export default function App() {
  const {
    books,
    loading,
    checkAuth,
    authChecked,
    authRequired,
    setupRequired,
    filters,
    query,
    clearFilters,
    selectedId,
    scan,
    busy,
    sort,
    view,
    select,
    setView,
    settingsOpen,
    setSettingsOpen,
  } = useStore();
  const [showImport, setShowImport] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [seriesInitial, setSeriesInitial] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    checkAuth();
    const params = new URLSearchParams(window.location.search);
    const bookId = params.get('book');
    if (bookId) select(bookId);
    if (params.get('view') === 'list') setView('list');
    if (params.get('view') === 'grid') setView('grid');
  }, [checkAuth, select, setView]);

  const visible = useMemo(
    () => selectVisible({ books, query, filters, sort }),
    [books, query, filters, sort],
  );

  // Si torna a pagina 1 solo se cambia la vista (ricerca, filtri, ordine), non
  // quando cambia `books`: modificare un voto non deve far saltare la pagina.
  useEffect(() => {
    setPage(1);
  }, [query, filters, sort]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageBooks = useMemo(
    () => visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [visible, currentPage],
  );

  const changePage = (next: number) => {
    setPage(next);
    document.getElementById('library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const hasFilters =
    query.length > 0 ||
    Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : value));

  const openImport = () => setShowImport(true);
  const openSettings = () => setSettingsOpen(true);
  const openSeries = (series?: string) => {
    setSeriesInitial(series?.trim() || null);
    setSeriesOpen(true);
  };

  if (!authChecked) return <div className="h-full bg-[#ede9de]" />;
  if (setupRequired) {
    return (
      <>
        <SetupPage />
        <Toasts />
      </>
    );
  }
  if (authRequired) {
    return (
      <>
        <LoginPage />
        <Toasts />
      </>
    );
  }

  return (
    <div className="h-full bg-[#ede9de] p-0 sm:p-3 lg:p-5">
      <div className="mx-auto flex h-full w-full max-w-[1720px] overflow-hidden bg-white sm:rounded-[30px] sm:shadow-shell">
        <Sidebar
          onOpenSettings={openSettings}
          onOpenSeries={() => openSeries()}
          onOpenStats={() => setStatsOpen(true)}
          mobileOpen={mobileFilters}
          onClose={() => setMobileFilters(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 overflow-y-auto bg-white">
            <TopBar
              onOpenImport={openImport}
              onOpenSettings={openSettings}
              onOpenFilters={() => setMobileFilters(true)}
              visibleCount={visible.length}
            />

            <div className="relative -mt-7 rounded-t-[32px] bg-white px-4 pb-12 pt-8 sm:px-7 lg:px-10 lg:pb-16 lg:pt-9">
              <section id="library" className="scroll-mt-6">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="eyebrow">La tua raccolta</p>
                    <h2 className="mt-1 text-[26px] font-semibold tracking-[-0.03em] text-ink-50 sm:text-[30px]">
                      La tua libreria
                    </h2>
                    <p className="mt-1 text-sm text-ink-500">
                      {visible.length === 1 ? '1 opera' : `${visible.length} opere`}
                      {query ? ` per “${query}”` : ' tra i tuoi scaffali'}
                      {pageCount > 1 ? ` · pagina ${currentPage} di ${pageCount}` : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => openSeries()} className="btn-ghost">
                      <IconLayers className="h-4 w-4" />
                      Serie
                    </button>
                    {hasFilters && (
                      <button onClick={clearFilters} className="btn-ghost">
                        Azzera i filtri
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-7">
                  {loading ? (
                    <SkeletonGrid />
                  ) : books.length === 0 ? (
                    <EmptyLibrary onImport={openImport} onScan={scan} busy={busy} />
                  ) : visible.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-3 rounded-[24px] border border-dashed border-black/10 bg-ink-800/60 px-6 py-20 text-center">
                      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-ink-400 shadow-soft">
                        <IconBook className="h-6 w-6" />
                      </span>
                      <p className="text-sm font-medium text-ink-200">
                        Nessuna opera corrisponde ai filtri.
                      </p>
                      <p className="max-w-sm text-xs leading-relaxed text-ink-500">
                        Prova a cambiare categoria o a cercare un titolo diverso.
                      </p>
                      {hasFilters && (
                        <button onClick={clearFilters} className="btn-primary mt-1">
                          Mostra tutta la libreria
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="animate-fade-in">
                      {view === 'grid' ? (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                          {pageBooks.map((book) => (
                            <BookCard key={book.id} book={book} />
                          ))}
                        </div>
                      ) : (
                        <BookList books={pageBooks} />
                      )}
                      <Pagination
                        page={currentPage}
                        pageCount={pageCount}
                        total={visible.length}
                        pageSize={PAGE_SIZE}
                        onChange={changePage}
                      />
                    </div>
                  )}
                </div>
              </section>

              {!loading && books.length > 0 && <CategoryShelf books={books} />}
            </div>
          </main>
        </div>
      </div>

      {selectedId && <DetailPanel onOpenSeries={openSeries} />}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {seriesOpen && (
        <SeriesDialog
          initialSeries={seriesInitial}
          onClose={() => {
            setSeriesOpen(false);
            setSeriesInitial(null);
          }}
        />
      )}
      {statsOpen && <StatsDialog onClose={() => setStatsOpen(false)} />}
      <Toasts />
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {Array.from({ length: 12 }).map((_, index) => (
        <div key={index} className="animate-pulse">
          <div className="aspect-[2/3] w-full rounded-[14px] bg-ink-750" />
          <div className="mt-3 h-3 w-3/4 rounded-full bg-ink-750" />
          <div className="mt-2 h-2.5 w-1/2 rounded-full bg-ink-750" />
        </div>
      ))}
    </div>
  );
}

function EmptyLibrary({
  onImport,
  onScan,
  busy,
}: {
  onImport: () => void;
  onScan: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 rounded-[28px] border border-dashed border-black/10 bg-ink-800/50 px-6 py-16 text-center sm:py-20">
      <div className="flex h-20 w-20 items-center justify-center rounded-[26px] bg-white text-accent-600 shadow-soft">
        <IconBook className="h-9 w-9" />
      </div>
      <div className="max-w-md space-y-2">
        <h2 className="text-xl font-semibold text-ink-50">La libreria è vuota</h2>
        <p className="text-sm leading-relaxed text-ink-400">
          Importa i tuoi ebook e le tue fanfiction: i metadati vengono letti automaticamente dal
          file (titolo, autore, copertina, fandom, parole totali) e puoi correggere o completare
          tutto a mano.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button onClick={onImport} className="btn-primary">
          <IconPlus className="h-4 w-4" />
          Importa un'opera
        </button>
        <button onClick={onScan} disabled={busy} className="btn-ghost">
          Scansiona la cartella
        </button>
      </div>
    </div>
  );
}

interface CategoryDefinition {
  quick: QuickFilter;
  label: string;
  description: string;
  icon: typeof IconBook;
  match: (book: BookSummary) => boolean;
}

const CATEGORIES: CategoryDefinition[] = [
  {
    quick: 'books',
    label: 'Libri',
    description: 'Romanzi, saggi e raccolte',
    icon: IconBook,
    match: (book) => book.kind === 'book',
  },
  {
    quick: 'fanfic',
    label: 'Fanfiction',
    description: 'Storie e fandom',
    icon: IconBookmark,
    match: (book) => book.kind === 'fanfic',
  },
  {
    quick: 'favorites',
    label: 'Preferiti',
    description: 'Le storie da rileggere',
    icon: IconHeart,
    match: (book) => book.favorite,
  },
  {
    quick: 'unread',
    label: 'Da leggere',
    description: 'In attesa sul comodino',
    icon: IconBookmark,
    match: (book) => book.readingStatus === 'unread',
  },
];

function CategoryShelf({ books }: { books: BookSummary[] }) {
  const filters = useStore((state) => state.filters);
  const setQuickFilter = useStore((state) => state.setQuickFilter);

  const apply = (quick: QuickFilter) => {
    setQuickFilter(quick);
    document.getElementById('library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section id="categories" className="mt-14 scroll-mt-6 border-t border-black/[0.06] pt-9">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Esplora</p>
          <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-ink-50">
            Categorie
          </h2>
        </div>
        <p className="max-w-sm text-xs leading-relaxed text-ink-500">
          Un colpo d'occhio sui tuoi scaffali. Scegli una categoria per filtrare la libreria.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {CATEGORIES.map((category) => {
          const matching = books.filter(category.match);
          const covers = matching.slice(0, 2);
          const active = matchesQuickFilter(filters, category.quick);
          const Icon = category.icon;

          return (
            <button
              key={category.quick}
              onClick={() => apply(category.quick)}
              className={cn(
                'group relative overflow-hidden rounded-[24px] bg-ink-800 p-3 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-ink-750 hover:shadow-soft sm:p-4',
                active && 'ring-2 ring-accent-500/35',
              )}
            >
              <div className="relative flex h-36 items-center justify-center overflow-hidden rounded-[18px] bg-[#f2ede3]">
                <span className="pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full bg-coral-200/30 blur-sm" />
                <span className="pointer-events-none absolute -bottom-10 -left-5 h-24 w-24 rounded-full bg-accent-100/60 blur-sm" />

                {covers.length > 0 ? (
                  <div className="relative flex h-full w-full items-end justify-center pb-0">
                    {covers.map((book, index) => (
                      <div
                        key={book.id}
                        className={cn(
                          'transition-transform duration-300 group-hover:-translate-y-1',
                          index === 0
                            ? 'relative z-10 -mr-3 rotate-[-4deg]'
                            : 'relative -ml-3 translate-y-1 rotate-[4deg]',
                        )}
                      >
                        <BookCover
                          id={book.id}
                          coverFile={book.coverFile}
                          title={book.title}
                          authors={book.authors}
                          kind={book.kind}
                          version={book.dateModified}
                          rounded="rounded-[8px]"
                          size="thumb"
                          className="h-[124px] w-[82px] shadow-book ring-1 ring-black/10"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-ink-400 shadow-soft">
                    <Icon className="h-6 w-6" />
                  </span>
                )}

                <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-1 text-[10px] font-semibold text-ink-300 shadow-sm backdrop-blur">
                  {matching.length}
                </span>
              </div>

              <div className="mt-3.5 flex items-center justify-between gap-2 px-0.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-100">{category.label}</p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-500">
                    {category.description}
                  </p>
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-ink-400 shadow-sm transition group-hover:bg-accent-600 group-hover:text-white">
                  <IconChevron className="h-4 w-4" />
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
