import { create } from 'zustand';
import { matchesQuery, searchScore } from './search';
import {
  ApiError,
  api,
  setActiveLibrary,
  setLibraryMissingHandler,
  setSetupRequiredHandler,
  setUnauthorizedHandler,
} from './api';
import { cn, lengthOf, READING_STATUS_LABEL } from './utils';
import type {
  BookHighlight,
  AppSettings,
  BookMeta,
  BookSummary,
  LibraryStats,
  LibrarySummary,
  LookupResult,
  ReadingStatus,
  SortKey,
} from '@shared/types';

export interface Filters {
  kinds: string[];
  formats: string[];
  authors: string[];
  fandoms: string[];
  series: string[];
  tags: string[];
  readingStatus: string[];
  favoritesOnly: boolean;
  missingCover: boolean;
  missingMetadata: boolean;
}

export const EMPTY_FILTERS: Filters = {
  kinds: [],
  formats: [],
  authors: [],
  fandoms: [],
  series: [],
  tags: [],
  readingStatus: [],
  favoritesOnly: false,
  missingCover: false,
  missingMetadata: false,
};

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
  actions?: ToastAction[];
}

export interface ToastAction {
  label: string;
  value: string;
  primary?: boolean;
}

/** Ultima libreria usata su questo dispositivo. */
const LIBRARY_STORAGE_KEY = 'books.library';
const MAIN_LIBRARY_ID = 'main';

function readStoredLibrary(): string | null {
  try {
    return window.localStorage.getItem(LIBRARY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLibrary(id: string): void {
  try {
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, id);
  } catch {
    /* localStorage non disponibile (navigazione privata): si perde solo la preferenza */
  }
}

/** Libreria da aprire all'avvio: ?lib= dell'URL, poi l'ultima usata, poi la principale. */
function initialLibraryId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('lib')?.trim();
  return fromUrl || readStoredLibrary() || MAIN_LIBRARY_ID;
}

/** Scrive `lib` nell'URL (senza ricaricare); `dropBook` toglie anche libro e scheda aperti. */
function writeLibraryToUrl(id: string, dropBook: boolean): void {
  const url = new URL(window.location.href);
  url.searchParams.set('lib', id);
  if (dropBook) {
    url.searchParams.delete('book');
    url.searchParams.delete('tab');
  }
  window.history.replaceState({}, '', url);
}

/** Libro e file aperti nel lettore integrato (URL `?read=<id>&file=<nome>`). */
export interface ReaderTarget {
  id: string;
  file: string;
  /** Posizione (CFI) da cui aprire, al posto dell'ultima salvata; non sta nell'URL. */
  location?: string;
}

function readerFromUrl(): ReaderTarget | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('read')?.trim();
  const file = params.get('file')?.trim();
  return id && file ? { id, file } : null;
}

export type QuickFilter = 'all' | 'books' | 'fanfic' | 'favorites' | 'unread';

export function matchesQuickFilter(filters: Filters, quick: QuickFilter): boolean {
  const emptyArrays =
    filters.formats.length === 0 &&
    filters.authors.length === 0 &&
    filters.fandoms.length === 0 &&
    filters.series.length === 0 &&
    filters.tags.length === 0;

  switch (quick) {
    case 'all':
      return (
        emptyArrays &&
        filters.kinds.length === 0 &&
        filters.readingStatus.length === 0 &&
        !filters.favoritesOnly &&
        !filters.missingCover &&
        !filters.missingMetadata
      );
    case 'books':
      return (
        emptyArrays &&
        filters.kinds.length === 1 &&
        filters.kinds[0] === 'book' &&
        filters.readingStatus.length === 0 &&
        !filters.favoritesOnly &&
        !filters.missingCover &&
        !filters.missingMetadata
      );
    case 'fanfic':
      return (
        emptyArrays &&
        filters.kinds.length === 1 &&
        filters.kinds[0] === 'fanfic' &&
        filters.readingStatus.length === 0 &&
        !filters.favoritesOnly &&
        !filters.missingCover &&
        !filters.missingMetadata
      );
    case 'favorites':
      return (
        emptyArrays &&
        filters.kinds.length === 0 &&
        filters.readingStatus.length === 0 &&
        filters.favoritesOnly &&
        !filters.missingCover &&
        !filters.missingMetadata
      );
    case 'unread':
      return (
        emptyArrays &&
        filters.kinds.length === 0 &&
        filters.readingStatus.length === 1 &&
        filters.readingStatus[0] === 'unread' &&
        !filters.favoritesOnly &&
        !filters.missingCover &&
        !filters.missingMetadata
      );
  }
}

const APPLE_AUTO_SYNC_KEY = 'books-editor.appleAutoSync';

/** Sincronizzazione automatica con Apple Books: attiva se non e' stata spenta. */
export function readAppleAutoSync(): boolean {
  try {
    return localStorage.getItem(APPLE_AUTO_SYNC_KEY) !== '0';
  } catch {
    return true;
  }
}

export function storeAppleAutoSync(enabled: boolean): void {
  try {
    localStorage.setItem(APPLE_AUTO_SYNC_KEY, enabled ? '1' : '0');
  } catch {
    /* localStorage non disponibile: vale solo per questa sessione */
  }
}

interface State {
  books: BookSummary[];
  stats: LibraryStats | null;
  settings: AppSettings | null;
  /** Librerie dell'account (con il numero di opere) e quella aperta in questa scheda. */
  libraries: LibrarySummary[];
  libraryId: string;
  loading: boolean;
  busy: boolean;
  query: string;
  sort: { key: SortKey; asc: boolean };
  view: 'grid' | 'list';
  filters: Filters;
  selectedId: string | null;
  detail: BookMeta | null;
  detailTab: 'details' | 'highlights' | 'cover' | 'online';
  /** Lettore integrato aperto (null = chiuso). */
  reader: ReaderTarget | null;
  lookup: LookupResult | null;
  lookupLoading: boolean;
  /** true dopo il primo tentativo di ricerca: evita cicli automatici. */
  lookupAttempted: boolean;
  /** Finestra delle impostazioni aperta (può essere aperta anche dal dettaglio). */
  settingsOpen: boolean;
  toasts: Toast[];
  /** Autenticazione: stato verificato con /auth/me, login richiesto, messaggio per la pagina di login. */
  authChecked: boolean;
  authEnabled: boolean;
  authRequired: boolean;
  authMessage: string;
  /** Primo avvio: nessun account, mostra la pagina di creazione. */
  setupRequired: boolean;
  setupCodeRequired: boolean;
  setupLibraryRoot: string | null;
  setupLibraryRootLocked: boolean;
  credentialsSource: 'env' | 'file' | null;
  authUser: string | null;
  /** Sincronizzazione automatica con Apple Books (solo app per Mac). */
  appleSync: { enabled: boolean; lastAt: number | null; updated: number };

  checkAuth: () => Promise<void>;
  loggedIn: () => Promise<void>;
  logout: () => Promise<void>;
  load: () => Promise<void>;
  /** Ricarica elenco e statistiche senza spinner e senza toccare selezione, filtri o pagina. */
  refreshBooks: () => Promise<void>;
  loadLibraries: () => Promise<void>;
  setLibrary: (id: string, options?: { select?: string }) => Promise<void>;
  moveBook: (toId: string) => Promise<void>;
  setQuery: (query: string) => void;
  setSort: (key: SortKey) => void;
  setView: (view: 'grid' | 'list') => void;
  toggleFilter: (group: keyof Filters, value: string) => void;
  setFlagFilter: (flag: keyof Filters, value: boolean) => void;
  setQuickFilter: (quick: QuickFilter) => void;
  clearFilters: () => void;
  select: (id: string | null) => Promise<void>;
  setDetailTab: (tab: 'details' | 'highlights' | 'cover' | 'online') => void;
  openReader: (id: string, file: string, location?: string) => void;
  closeReader: () => void;
  /** Aggiorna in silenzio avanzamento e stato della card dopo un salvataggio del lettore. */
  applyReadingProgress: (id: string, progress: number) => void;
  /** Sostituisce le sottolineature del libro nel dettaglio aperto (lettore e scheda Sottolineature). */
  setHighlights: (id: string, highlights: BookHighlight[]) => void;
  /** «Segna come non letto», con conferma: azzera stato, avanzamento, data di fine e posizioni. */
  resetReading: () => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
  patchDetail: (patch: Partial<BookMeta>) => Promise<void>;
  runLookup: () => Promise<void>;
  importGoogleVolume: (url: string) => Promise<boolean>;
  importAo3: (url: string) => Promise<boolean>;
  applyCandidate: (candidate: Parameters<typeof api.apply>[1]) => Promise<void>;
  reloadBook: (id: string) => Promise<void>;
  scan: () => Promise<void>;
  toast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  answerToast: (id: number, value: string) => void;
  confirm: (
    message: string,
    actions: ToastAction[],
    options?: { tone?: Toast['tone']; timeoutMs?: number },
  ) => Promise<string | null>;
  setSettings: (settings: Partial<AppSettings>) => Promise<void>;
}

let toastId = 0;
// Funzioni di risoluzione delle notifiche con azioni (fuori dallo stato).
const toastResolvers = new Map<number, (value: string | null) => void>();

function matchesFilters(book: BookSummary, filters: Filters): boolean {
  if (filters.kinds.length && !filters.kinds.includes(book.kind)) return false;
  if (filters.formats.length && !filters.formats.includes(book.format)) return false;
  if (filters.authors.length && !book.authors.some((a) => filters.authors.includes(a))) return false;
  if (filters.fandoms.length && !filters.fandoms.includes(book.fandom)) return false;
  if (filters.series.length && !filters.series.includes(book.series)) return false;
  if (filters.tags.length && !book.tags.some((t) => filters.tags.includes(t))) return false;
  if (filters.readingStatus.length && !filters.readingStatus.includes(book.readingStatus)) return false;
  if (filters.favoritesOnly && !book.favorite) return false;
  if (filters.missingCover && book.coverFile) return false;
  if (filters.missingMetadata && book.authors.length && book.description) return false;
  return true;
}

export function selectVisible(state: {
  books: BookSummary[];
  query: string;
  filters: Filters;
  sort: { key: SortKey; asc: boolean };
}): BookSummary[] {
  const filtered = state.books.filter(
    (book) => matchesQuery(book, state.query) && matchesFilters(book, state.filters),
  );
  // Con una ricerca i risultati vanno per pertinenza (titolo, poi autore); a parita'
  // vale l'ordinamento scelto.
  const scores = new Map<string, number>();
  if (state.query.trim()) {
    for (const book of filtered) scores.set(book.id, searchScore(book, state.query));
  }

  const { key, asc } = state.sort;
  const direction = asc ? 1 : -1;
  const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });

  filtered.sort((a, b) => {
    let result = 0;
    switch (key) {
      case 'author':
        result = collator.compare(a.authors[0] ?? '', b.authors[0] ?? '');
        break;
      case 'series':
        result = collator.compare(a.series || '￿', b.series || '￿');
        if (result === 0) result = (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0);
        break;
      case 'length':
        result = lengthOf(a) - lengthOf(b);
        break;
      case 'rating':
        result = (a.rating ?? -1) - (b.rating ?? -1);
        break;
      case 'publishedDate':
        result = (a.publishedDate || '').localeCompare(b.publishedDate || '');
        break;
      case 'dateAdded':
        result = a.dateAdded.localeCompare(b.dateAdded);
        break;
      case 'dateModified':
        result = a.dateAdded.localeCompare(b.dateAdded);
        break;
      case 'lastRead':
        result = (a.lastRead || '').localeCompare(b.lastRead || '');
        break;
      case 'dateFinished':
        result = (a.dateFinished || '').localeCompare(b.dateFinished || '');
        break;
      case 'readingProgress':
        result = (a.readingProgress ?? -1) - (b.readingProgress ?? -1);
        break;
      case 'fandom':
        result = collator.compare(a.fandom || '￿', b.fandom || '￿');
        break;
      default:
        result = collator.compare(a.title, b.title);
    }
    if (result === 0) result = collator.compare(a.title, b.title);
    const relevance = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
    return relevance || result * direction;
  });

  return filtered;
}

export const useStore = create<State>((set, get) => ({
  books: [],
  stats: null,
  settings: null,
  libraries: [],
  libraryId: initialLibraryId(),
  loading: true,
  busy: false,
  query: '',
  sort: { key: 'title', asc: true },
  view: 'grid',
  filters: { ...EMPTY_FILTERS },
  selectedId: null,
  detail: null,
  reader: readerFromUrl(),
  detailTab: 'details',
  lookup: null,
  lookupLoading: false,
  lookupAttempted: false,
  settingsOpen: false,
  toasts: [],
  authChecked: false,
  authEnabled: false,
  authRequired: false,
  authMessage: '',
  setupRequired: false,
  setupCodeRequired: false,
  setupLibraryRoot: null,
  setupLibraryRootLocked: false,
  credentialsSource: null,
  authUser: null,
  appleSync: { enabled: readAppleAutoSync(), lastAt: null, updated: 0 },

  checkAuth: async () => {
    try {
      const status = await api.authMe();
      set({
        authChecked: true,
        authEnabled: status.authEnabled,
        authRequired: status.authEnabled && !status.authenticated && !status.setupRequired,
        setupRequired: status.setupRequired,
        setupCodeRequired: status.setupCodeRequired,
        setupLibraryRoot: status.setupLibraryRoot ?? null,
        setupLibraryRootLocked: status.setupLibraryRootLocked ?? false,
        credentialsSource: status.credentialsSource,
        authUser: status.user,
      });
      if (!status.setupRequired && (!status.authEnabled || status.authenticated)) await get().load();
    } catch (error) {
      set({ authChecked: true });
      get().toast((error as Error).message, 'error');
    }
  },
  loggedIn: async () => {
    // Ricarica lo stato (utente, origine delle credenziali) prima della libreria.
    set({ authRequired: false, setupRequired: false, authMessage: '' });
    await get().checkAuth();
  },
  logout: async () => {
    try {
      await api.logout();
    } catch {
      /* in ogni caso si torna al login */
    }
    set({
      authRequired: true,
      authMessage: '',
      books: [],
      selectedId: null,
      detail: null,
      settingsOpen: false,
    });
  },

  load: async () => {
    set({ loading: true });
    const libraryId = get().libraryId;
    try {
      const [{ books, stats }, settings, libraries] = await Promise.all([
        api.books(),
        api.settings(),
        api.libraries(),
      ]);
      // Nel frattempo si e' passati a un'altra libreria: questa risposta non serve piu'.
      if (get().libraryId !== libraryId) return;
      set({ books, stats, settings, libraries, loading: false });
    } catch (error) {
      if (get().libraryId !== libraryId) return;
      set({ loading: false });
      // Con 401 compare gia' la pagina di login; con 404 «Libreria inesistente» si torna alla principale.
      const missing = error instanceof ApiError && error.status === 404 && error.message === 'Libreria inesistente';
      if (!(error instanceof ApiError && error.status === 401) && !missing) {
        get().toast((error as Error).message, 'error');
      }
    }
  },

  refreshBooks: async () => {
    const libraryId = get().libraryId;
    try {
      const { books, stats } = await api.books();
      // Cambio libreria nel frattempo: la risposta non e' piu' valida.
      if (get().libraryId !== libraryId) return;
      set({ books, stats });
    } catch (error) {
      console.warn('[store] ricarica silenziosa non riuscita:', (error as Error).message);
    }
  },

  loadLibraries: async () => {
    try {
      set({ libraries: await api.libraries() });
    } catch (error) {
      get().toast((error as Error).message, 'error');
    }
  },

  setLibrary: async (id, options = {}) => {
    setActiveLibrary(id);
    storeLibrary(id);
    writeLibraryToUrl(id, true);
    // Selezione, filtri, ricerca e dettaglio sono della libreria che si lascia.
    set({
      libraryId: id,
      books: [],
      stats: null,
      selectedId: null,
      detail: null,
      lookup: null,
      lookupAttempted: false,
      query: '',
      filters: { ...EMPTY_FILTERS },
      loading: true,
    });
    await get().load();
    if (options.select) await get().select(options.select);
  },

  moveBook: async (toId) => {
    const { detail, libraries } = get();
    const target = libraries.find((library) => library.id === toId);
    if (!detail || !target) return;
    const answer = await get().confirm(`Spostare «${detail.title || 'Senza titolo'}» in «${target.name}»?`, [
      { label: 'Sposta', value: 'move', primary: true },
      { label: 'Annulla', value: 'cancel' },
    ]);
    if (answer !== 'move') return;
    set({ busy: true });
    try {
      await api.moveBook(detail.id, toId);
      set({ busy: false });
      // Il libro non e' piu' qui: la scheda si chiude e liste e conteggi si ricaricano.
      await get().select(null);
      await get().load();
      const open = await get().confirm(
        `«${detail.title || 'Senza titolo'}» spostato in «${target.name}»`,
        [{ label: `Apri «${target.name}»`, value: 'open', primary: true }],
        { tone: 'success', timeoutMs: 9000 },
      );
      if (open === 'open') await get().setLibrary(toId, { select: detail.id });
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
    }
  },

  setQuery: (query) => set({ query }),
  setSort: (key) =>
    set((state) => ({
      sort: state.sort.key === key ? { key, asc: !state.sort.asc } : { key, asc: true },
    })),
  setView: (view) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    window.history.replaceState({}, '', url);
    set({ view });
  },

  toggleFilter: (group, value) =>
    set((state) => {
      const current = state.filters[group] as string[];
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      return { filters: { ...state.filters, [group]: next } };
    }),

  setFlagFilter: (flag, value) =>
    set((state) => ({ filters: { ...state.filters, [flag]: value } })),

  setQuickFilter: (quick) =>
    set(() => {
      const next: Filters = { ...EMPTY_FILTERS };
      if (quick === 'books') next.kinds = ['book'];
      if (quick === 'fanfic') next.kinds = ['fanfic'];
      if (quick === 'favorites') next.favoritesOnly = true;
      if (quick === 'unread') next.readingStatus = ['unread'];
      return { filters: next };
    }),

  clearFilters: () => set({ filters: { ...EMPTY_FILTERS }, query: '' }),

  select: async (id) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('book', id);
    else url.searchParams.delete('book');
    window.history.replaceState({}, '', url);

    if (!id) {
      set({ selectedId: null, detail: null, lookup: null, lookupAttempted: false });
      return;
    }
    const tab = new URLSearchParams(window.location.search).get('tab');
    set({
      selectedId: id,
      detail: null,
      lookup: null,
      lookupAttempted: false,
      detailTab:
        tab === 'cover' || tab === 'online' || tab === 'highlights' ? tab : 'details',
    });
    try {
      const detail = await api.book(id);
      set({ detail });
    } catch (error) {
      get().toast((error as Error).message, 'error');
    }
  },

  setDetailTab: (detailTab) => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', detailTab);
    window.history.replaceState({}, '', url);
    set({ detailTab });
  },

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  // Il lettore ha una voce di cronologia propria: «Indietro», Esc e lo swipe di iOS lo chiudono.
  openReader: (id, file, location) => {
    const url = new URL(window.location.href);
    url.searchParams.set('read', id);
    url.searchParams.set('file', file);
    window.history.pushState({ reader: true }, '', url);
    set({ reader: { id, file, location } });
  },

  closeReader: () => {
    if (!get().reader) return;
    if (window.history.state?.reader) {
      // Lo stato lo azzera l'evento popstate.
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('read');
    url.searchParams.delete('file');
    window.history.replaceState({}, '', url);
    set({ reader: null });
  },

  applyReadingProgress: (id, progress) => {
    const percent = Math.round(progress);
    const patchStatus = <T extends { readingStatus: ReadingStatus }>(item: T) =>
      item.readingStatus === 'unread' ? 'reading' : item.readingStatus;
    set((state) => ({
      books: state.books.map((book) =>
        book.id === id
          ? { ...book, readingProgress: percent, readingStatus: patchStatus(book) }
          : book,
      ),
      detail:
        state.detail?.id === id
          ? { ...state.detail, readingProgress: percent, readingStatus: patchStatus(state.detail) }
          : state.detail,
    }));
  },

  setHighlights: (id, highlights) => {
    set((state) => (state.detail?.id === id ? { detail: { ...state.detail, highlights } } : {}));
  },

  resetReading: async () => {
    const { detail } = get();
    if (!detail) return;
    const answer = await get().confirm(
      `Segnare «${detail.title || 'Senza titolo'}» come non letto? Avanzamento, data di fine lettura e posizione nel lettore verranno azzerati.`,
      [
        { label: 'Segna come non letto', value: 'reset', primary: true },
        { label: 'Annulla', value: 'cancel' },
      ],
    );
    if (answer !== 'reset') return;
    set({ busy: true });
    try {
      const updated = await api.resetReading(detail.id);
      set((state) => ({
        busy: false,
        detail: state.detail?.id === updated.id ? updated : state.detail,
        books: state.books.map((book) =>
          book.id === updated.id
            ? {
                ...book,
                readingStatus: updated.readingStatus,
                readingProgress: updated.readingProgress,
                dateFinished: updated.dateFinished,
              }
            : book,
        ),
      }));
      get().toast('Segnato come non letto', 'success');
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
    }
  },

  patchDetail: async (patch) => {
    const { detail } = get();
    if (!detail) return;
    set({ busy: true });
    try {
      const updated = await api.updateBook(detail.id, patch);
      set((state) => ({
        detail: updated,
        busy: false,
        books: state.books.map((book) =>
          book.id === updated.id
            ? {
                ...book,
                title: updated.title,
                subtitle: updated.subtitle,
                authors: updated.authors,
                series: updated.series,
                seriesIndex: updated.seriesIndex,
                kind: updated.kind,
                coverFile: updated.coverFile,
                fandom: updated.fandom,
                tags: updated.tags,
                rating: updated.rating,
                fanRating: updated.fanRating,
                status: updated.status,
                wordCount: updated.wordCount,
                pageCount: updated.pageCount,
                publishedDate: updated.publishedDate,
                readingStatus: updated.readingStatus,
                readingProgress: updated.readingProgress,
                dateFinished: updated.dateFinished,
                favorite: updated.favorite,
                publisher: updated.publisher,
                language: updated.language,
                isbn: updated.isbn,
                ao3Url: updated.ao3Url,
              }
            : book,
        ),
      }));
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
    }
  },

  runLookup: async () => {
    const { detail } = get();
    if (!detail) return;
    set({ lookupLoading: true, lookup: null, lookupAttempted: true });
    try {
      const lookup = await api.lookup(detail.id);
      set({ lookup, lookupLoading: false });
    } catch (error) {
      const message = (error as Error).message;
      set({
        lookupLoading: false,
        lookup: { candidates: [], missing: [], errors: [message] },
      });
      get().toast(message, 'error');
    }
  },

  importGoogleVolume: async (url) => {
    const { detail, lookup } = get();
    if (!detail || !url.trim()) return false;
    set({ busy: true });
    try {
      const result = await api.lookupGoogle(detail.id, url.trim());
      const incoming = result.candidates[0];
      const existing = lookup?.candidates ?? [];
      const rest = incoming
        ? existing.filter(
            (candidate) =>
              candidate.provider !== 'googlebooks' ||
              candidate.fields.identifiers?.googlebooks !==
                incoming.fields.identifiers?.googlebooks,
          )
        : existing;
      set({
        busy: false,
        lookupAttempted: true,
        lookup: {
          candidates: incoming ? [incoming, ...rest] : existing,
          errors: [],
          missing: result.missing,
        },
      });
      if (incoming) get().toast('Edizione Google Books importata', 'success');
      return Boolean(incoming);
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
      return false;
    }
  },

  importAo3: async (url) => {
    const { detail, lookup } = get();
    if (!detail || !url.trim()) return false;
    set({ busy: true });
    try {
      const result = await api.lookupAo3(detail.id, url.trim());
      const incoming = result.candidates[0];
      const existing = lookup?.candidates ?? [];
      const rest = incoming
        ? existing.filter((candidate) => candidate.provider !== 'ao3')
        : existing;
      set({
        busy: false,
        lookupAttempted: true,
        lookup: {
          candidates: incoming ? [incoming, ...rest] : existing,
          errors: [],
          missing: result.missing,
        },
      });
      if (incoming) get().toast('Metadati AO3 importati', 'success');
      return Boolean(incoming);
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
      return false;
    }
  },

  applyCandidate: async (candidate) => {
    const { detail } = get();
    if (!detail) return;
    set({ busy: true });
    try {
      const updated = await api.apply(detail.id, candidate);
      set({ detail: updated, busy: false, lookup: null });
      await get().reloadBook(updated.id);
      get().toast('Metadati aggiornati', 'success');
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
    }
  },

  reloadBook: async (id) => {
    try {
      const [detail, { books }] = await Promise.all([api.book(id), api.books()]);
      set((state) => ({
        detail: state.selectedId === id ? detail : state.detail,
        books,
      }));
    } catch (error) {
      get().toast((error as Error).message, 'error');
    }
  },

  scan: async () => {
    set({ busy: true });
    try {
      const result = await api.scan();
      const { books, stats } = await api.books();
      set({ books, stats, busy: false });
      const parts = [`${result.added} nuovi`, `${result.updated} aggiornati`];
      if (result.removed) parts.push(`${result.removed} rimossi`);
      get().toast(`Scansione completata: ${parts.join(', ')}`, 'success');
      if (result.errors.length) {
        get().toast(`${result.errors.length} errori durante la scansione`, 'error');
      }
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
    }
  },

  toast: (message, tone = 'info') => {
    const id = ++toastId;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), 4200);
  },

  dismissToast: (id) => {
    // Una notifica con azioni chiusa senza scelta risolve con null.
    const resolve = toastResolvers.get(id);
    if (resolve) {
      toastResolvers.delete(id);
      resolve(null);
    }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  answerToast: (id, value) => {
    const resolve = toastResolvers.get(id);
    toastResolvers.delete(id);
    resolve?.(value);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  confirm: (message, actions, options = {}) =>
    new Promise<string | null>((resolve) => {
      const id = ++toastId;
      toastResolvers.set(id, resolve);
      set((state) => ({
        toasts: [...state.toasts, { id, message, tone: options.tone ?? 'info', actions }],
      }));
      // Di norma la domanda resta finche' non si risponde; un avviso con azione scade da solo.
      if (options.timeoutMs) setTimeout(() => get().dismissToast(id), options.timeoutMs);
    }),

  setSettings: async (patch) => {
    set({ busy: true });
    try {
      const settings = await api.updateSettings(patch);
      set({ settings, busy: false });
      get().toast('Impostazioni salvate', 'success');
      // Il nome della libreria puo' essere cambiato da qui.
      void get().loadLibraries();
    } catch (error) {
      set({ busy: false });
      get().toast((error as Error).message, 'error');
    }
  },
}));

/** Nome della libreria aperta (dall'elenco, altrimenti dalle impostazioni). */
export function libraryNameOf(state: {
  libraries: LibrarySummary[];
  libraryId: string;
  settings: AppSettings | null;
}): string {
  const fromList = state.libraries.find((library) => library.id === state.libraryId)?.name;
  return fromList?.trim() || state.settings?.libraryName?.trim() || 'La mia libreria';
}

/** Etichette leggibili per i filtri laterali. */
export function describeFilter(group: keyof Filters, value: string): string {
  switch (group) {
    case 'kinds':
      return value === 'fanfic' ? 'Fanfiction' : 'Libri';
    case 'formats':
      return value.toUpperCase();
    case 'readingStatus':
      return READING_STATUS_LABEL[value as ReadingStatus] ?? value;
    default:
      return value;
  }
}

export function toggleArrayFilter(
  filters: Filters,
  group: keyof Filters,
  value: string,
): Filters {
  const current = filters[group] as string[];
  return {
    ...filters,
    [group]: current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value],
  };
}

export const filterClasses = (active: boolean) =>
  cn(
    'w-full truncate rounded-md px-2 py-1 text-left text-[13px] transition',
    active
      ? 'bg-accent-500/10 font-medium text-accent-700'
      : 'text-ink-400 hover:bg-black/[0.035] hover:text-ink-100',
  );

// La libreria aperta non esiste piu' (cancellata da un altro dispositivo): si torna alla principale.
setActiveLibrary(useStore.getState().libraryId);
writeLibraryToUrl(useStore.getState().libraryId, false);
setLibraryMissingHandler(() => {
  if (useStore.getState().libraryId === MAIN_LIBRARY_ID) return;
  useStore.getState().toast('La libreria non esiste più: torno alla libreria principale', 'error');
  void useStore.getState().setLibrary(MAIN_LIBRARY_ID);
});

// Una risposta 401 da qualunque chiamata riporta alla pagina di login.
setSetupRequiredHandler(() => {
  if (useStore.getState().setupRequired) return;
  useStore.setState({ authEnabled: true, authRequired: false, setupRequired: true, books: [], selectedId: null, detail: null });
  void useStore.getState().checkAuth();
});

setUnauthorizedHandler(() => {
  if (useStore.getState().authRequired) return;
  useStore.setState({ authEnabled: true, authRequired: true, authMessage: 'Sessione scaduta, accedi di nuovo' });
});

// «Indietro» del browser (o lo swipe di iOS) apre o chiude il lettore secondo l'URL.
window.addEventListener('popstate', () => {
  const next = readerFromUrl();
  const current = useStore.getState().reader;
  if (next?.id === current?.id && next?.file === current?.file) return;
  useStore.setState({ reader: next });
});
