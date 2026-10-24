import type {
  AppSettings,
  AppleBooksImportResult,
  AppleBooksRawData,
  AppleBooksWriteField,
  AppleBooksWriteStatus,
  Ao3SessionState,
  BookHighlight,
  BookKind,
  BookMeta,
  BookSummary,
  ConversionSupport,
  FanficCheckState,
  HighlightColor,
  LibraryStats,
  LibrarySummary,
  LookupResult,
  MetadataCandidate,
  ScanResult,
  SeriesLookupResult,
  SeriesVolume,
} from '@shared/types';

/** Errore HTTP dell'API: conserva stato e corpo della risposta. */
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Chiamato quando l'API risponde 401 (sessione scaduta o assente). */
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

/** Chiamato quando l'API risponde 403 con setupRequired (account da creare). */
let setupRequiredHandler: (() => void) | null = null;
export function setSetupRequiredHandler(handler: () => void): void {
  setupRequiredHandler = handler;
}

function notifyUnauthorized(path: string, status: number, body?: unknown): void {
  if (status === 401 && path !== '/auth/login') unauthorizedHandler?.();
  if (status === 403 && (body as { setupRequired?: boolean } | undefined)?.setupRequired) setupRequiredHandler?.();
  if (status === 404 && (body as { error?: string } | undefined)?.error === 'Libreria inesistente') {
    libraryMissingHandler?.();
  }
}

/** Libreria aperta in questa scheda: ogni richiesta la indica nell'header `X-Library`. */
let activeLibraryId = 'main';
export function setActiveLibrary(id: string): void {
  activeLibraryId = id;
}
export function getActiveLibrary(): string {
  return activeLibraryId;
}

/**
 * Aggiunge `lib=<id>` a un URL `/api/...` usato da <img>, <a href> o window.open,
 * che non possono mandare l'header.
 */
export function withLibrary(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}lib=${encodeURIComponent(activeLibraryId)}`;
}

/** Chiamato quando il server risponde 404 «Libreria inesistente» (libreria cancellata). */
let libraryMissingHandler: (() => void) | null = null;
export function setLibraryMissingHandler(handler: () => void): void {
  libraryMissingHandler = handler;
}

/** Limite di upload dichiarato dal server (noto dopo aver letto le impostazioni). */
let knownMaxUploadMb: number | null = null;

/** Messaggio per un 413, sia che arrivi dall'app (JSON) sia da nginx (HTML). */
export function tooLargeMessage(): string {
  return knownMaxUploadMb
    ? `File troppo grande per il server (limite ${knownMaxUploadMb} MB)`
    : 'File troppo grande per il server';
}

function errorMessage(status: number, body: { error?: string }): string {
  if (status === 413) return tooLargeMessage();
  return body.error ?? `Errore ${status}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'X-Library': activeLibraryId,
    // Un header esplicito (es. sincronizzazione di un'altra libreria) vince su quello della libreria aperta.
    ...(init.headers as Record<string, string>),
  };
  const isFormData = init.body instanceof FormData;
  // Fastify rifiuta un body vuoto con content-type json: lo impostiamo solo
  // quando c'è effettivamente un corpo.
  if (!isFormData && init.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { error?: string });
    notifyUnauthorized(path, response.status, body);
    throw new ApiError(errorMessage(response.status, body), response.status, body);
  }
  return (await response.json()) as T;
}

async function requestBlob(
  path: string,
  init: RequestInit = {},
  fallbackName = 'storia-efp.odt',
): Promise<{ blob: Blob; filename: string; metadata: string | null }> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'X-Library': activeLibraryId,
  };
  if (init.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`/api${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as { error?: string });
    notifyUnauthorized(path, response.status, body);
    throw new ApiError(errorMessage(response.status, body), response.status, body);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : plain ?? fallbackName;
  return { blob: await response.blob(), filename, metadata: response.headers.get('X-Books-Metadata') };
}

export interface EfpImportResult {
  book: BookMeta;
  created: boolean;
  chapters: number;
  words: number;
}

export interface JellyfinInfo {
  serverName: string;
  version: string;
}

export interface JellyfinLibrary {
  id: string;
  name: string;
  type: string;
}

export type JellyfinStatus = 'new' | 'duplicate' | 'imported' | 'unsupported';

export interface JellyfinPreviewItem {
  id: string;
  title: string;
  authors: string[];
  format: string;
  status: JellyfinStatus;
  existing?: { id: string; title: string };
  reason?: 'library' | 'jellyfin-copy';
  uncertain?: boolean;
}

export interface JellyfinPreview {
  total: number;
  counts: Record<JellyfinStatus, number> & { uncertain: number };
  items: JellyfinPreviewItem[];
}

export interface JellyfinImportState {
  running: boolean;
  libraryId: string;
  total: number;
  done: number;
  imported: Array<{ id: string; title: string; kind?: 'book' | 'fanfic' }>;
  duplicates: Array<{ title: string; existing: string }>;
  /** File aggiunti come altra lingua di un libro gia' presente. */
  editions: Array<{ title: string; book: string; language: string }>;
  skipped: number;
  errors: Array<{ title: string; message: string }>;
  startedAt: string;
  finishedAt: string | null;
}

export interface AuthStatus {
  authEnabled: boolean;
  authenticated: boolean;
  user: string | null;
  setupRequired: boolean;
  setupCodeRequired: boolean;
  setupLibraryRoot?: string | null;
  setupLibraryRootLocked?: boolean;
  credentialsSource: 'env' | 'file' | null;
}

export const api = {
  authMe: () => request<AuthStatus>('/auth/me'),
  setup: (username: string, password: string, setupCode?: string, libraryRoot?: string) =>
    request<{ ok: boolean; user: string }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password, setupCode, libraryRoot }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  login: (username: string, password: string) =>
    request<{ ok: boolean; user: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' }),
  settings: async () => {
    const settings = await request<AppSettings>('/settings');
    knownMaxUploadMb = settings.maxUploadMb ?? null;
    return settings;
  },
  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  libraries: () => request<LibrarySummary[]>('/libraries'),
  createLibrary: (name: string) =>
    request<LibrarySummary>('/libraries', { method: 'POST', body: JSON.stringify({ name }) }),
  /** Mostra o nasconde le fanfiction di una libreria. */
  setHideFanfics: (id: string, hideFanfics: boolean) =>
    request<LibrarySummary>(`/libraries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ hideFanfics }),
    }),
  renameLibrary: (id: string, name: string) =>
    request<LibrarySummary>(`/libraries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteLibrary: (id: string) =>
    request<{ ok: boolean }>(`/libraries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Sposta il libro dalla libreria aperta a `to`. */
  moveBook: (id: string, to: string) =>
    request<{ ok: boolean; to: string; book: BookMeta }>(`/books/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),

  books: () => request<{ books: BookSummary[]; stats: LibraryStats }>('/books'),
  book: (id: string) => request<BookMeta>(`/books/${id}`),
  updateBook: (id: string, patch: Partial<BookMeta>) =>
    request<BookMeta>(`/books/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteBook: (id: string, keepFiles = false) =>
    request<{ ok: boolean }>(`/books/${id}?keepFiles=${keepFiles ? '1' : '0'}`, { method: 'DELETE' }),

  uploadCover: async (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<BookMeta>(`/books/${id}/cover`, { method: 'POST', body: form });
  },
  removeCover: (id: string) => request<BookMeta>(`/books/${id}/cover`, { method: 'DELETE' }),
  extractCover: (id: string) =>
    request<BookMeta>(`/books/${id}/cover/extract`, { method: 'POST' }),
  coverFromUrl: (id: string, url: string) =>
    request<BookMeta>(`/books/${id}/cover/url`, { method: 'POST', body: JSON.stringify({ url }) }),

  /**
   * File principale dell'opera, o uno dei file extra se `file` e' indicato.
   * Con `meta` l'EPUB porta i metadati della scheda; `metadata` dice cosa ha servito il server
   * ('card' o 'original').
   */
  downloadBook: (id: string, file?: string, options: { meta?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (file) query.set('file', file);
    if (options.meta) query.set('meta', '1');
    const qs = query.toString();
    return requestBlob(`/books/${id}/download${qs ? `?${qs}` : ''}`, {}, file ?? 'libro');
  },
  /** Salva la posizione di lettura del lettore integrato (il server aggiorna anche l'avanzamento). */
  saveReadingPosition: (id: string, body: { file: string; location: string; progress: number }) =>
    request<{ ok: true }>(`/books/${id}/reading-position`, { method: 'POST', body: JSON.stringify(body) }),
  /** «Segna come non letto»: azzera stato, avanzamento, data di fine e posizioni del lettore. */
  resetReading: (id: string) => request<BookMeta>(`/books/${id}/reset-reading`, { method: 'POST' }),
  /** Sottolineature create nel lettore integrato (quelle di Apple Books non si modificano). */
  createHighlight: (
    id: string,
    body: { file: string; location: string; text: string; color: HighlightColor; note?: string; chapter?: string },
  ) => request<BookHighlight>(`/books/${id}/highlights`, { method: 'POST', body: JSON.stringify(body) }),
  updateHighlight: (id: string, highlightId: string, patch: { color?: HighlightColor; note?: string }) =>
    request<BookHighlight>(`/books/${id}/highlights/${encodeURIComponent(highlightId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteHighlight: (id: string, highlightId: string) =>
    request<{ ok: true }>(`/books/${id}/highlights/${encodeURIComponent(highlightId)}`, { method: 'DELETE' }),
  writeEpub: (id: string) =>
    request<{ fields: string[]; cover: boolean; backup: string }>(`/books/${id}/write-epub`, {
      method: 'POST',
    }),
  appleBooksStatus: (id: string) => request<AppleBooksWriteStatus>(`/books/${id}/applebooks`),
  writeAppleBooks: (id: string, fields: AppleBooksWriteField[], quitApp = false) =>
    request<{ written: AppleBooksWriteField[]; backup: string; reopened: boolean }>(`/books/${id}/applebooks`, {
      method: 'POST',
      body: JSON.stringify({ fields, quitApp }),
    }),
  refresh: (id: string) => request<BookMeta>(`/books/${id}/refresh`, { method: 'POST' }),
  lookup: (id: string) => request<LookupResult>(`/books/${id}/lookup`, { method: 'POST' }),
  lookupGoogle: (id: string, url: string) =>
    request<LookupResult>(`/books/${id}/lookup/google`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  lookupAo3: (id: string, url: string) =>
    request<LookupResult>(`/books/${id}/lookup/ao3`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  apply: (id: string, candidate: MetadataCandidate) =>
    request<BookMeta>(`/books/${id}/apply`, { method: 'POST', body: JSON.stringify({ candidate }) }),
  seriesLookup: (
    series: string,
    authors: string[],
    options: {
      isbns?: string[];
      ao3Urls?: string[];
      kind?: BookKind;
      refresh?: boolean;
    } = {},
  ) =>
    request<SeriesLookupResult>('/series/lookup', {
      method: 'POST',
      body: JSON.stringify({ series, authors, ...options }),
    }),
  seriesCached: (groups: Array<{ series: string; authors: string[]; kind: BookKind }>) =>
    request<{ results: Array<{ volumes: SeriesVolume[]; at: number } | null> }>(
      '/series/cached',
      { method: 'POST', body: JSON.stringify({ groups }) },
    ),
  seriesTotals: () => request<Record<string, number>>('/series/totals'),
  setSeriesTotal: (key: string, total: number | null) =>
    request<Record<string, number>>('/series/totals', {
      method: 'PUT',
      body: JSON.stringify({ key, total }),
    }),

  importAppleBooks: (options: { dryRun?: boolean } = {}) =>
    request<AppleBooksImportResult>('/apple-books/import', {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  appleBooksCapabilities: () => request<{ local: boolean }>('/apple-books/capabilities'),
  importAppleBooksData: (
    data: Pick<AppleBooksRawData, 'annotations' | 'library'>,
    options: { dryRun?: boolean; bookIds?: string[]; libraryId?: string } = {},
  ) => {
    // `libraryId` sceglie la libreria senza cambiare quella aperta: va nell'header, non nel corpo.
    const { libraryId, ...body } = options;
    return request<AppleBooksImportResult>('/apple-books/import-data', {
      method: 'POST',
      headers: libraryId ? { 'X-Library': libraryId } : undefined,
      body: JSON.stringify({ annotations: data.annotations, library: data.library, ...body }),
    });
  },

  scan: () => request<ScanResult>('/library/scan', { method: 'POST' }),
  importPath: (path: string, options: { force?: boolean; attachTo?: string } = {}) =>
    request<BookMeta>('/library/import', {
      method: 'POST',
      body: JSON.stringify({
        path,
        ...(options.force ? { force: true } : {}),
        ...(options.attachTo ? { attachTo: options.attachTo } : {}),
      }),
    }),
  importEfp: (url: string, mode?: 'update' | 'new') =>
    request<EfpImportResult>('/efp/import', {
      method: 'POST',
      body: JSON.stringify({ url, ...(mode ? { mode } : {}) }),
    }),
  downloadEfp: (url: string, format: 'odt' | 'epub' = 'odt') =>
    requestBlob('/efp/download', {
      method: 'POST',
      body: JSON.stringify({ url, format }),
    }),
  conversion: () => request<ConversionSupport>('/conversion'),
  uploadFile: async (file: File, options: { force?: boolean; attachTo?: string } = {}) => {
    const form = new FormData();
    form.append('file', file);
    const query = new URLSearchParams();
    if (options.force) query.set('force', '1');
    if (options.attachTo) query.set('attachTo', options.attachTo);
    const suffix = query.toString();
    return request<BookMeta>(`/library/upload${suffix ? `?${suffix}` : ''}`, {
      method: 'POST',
      body: form,
    });
  },

  /* Lingue: altre edizioni della stessa opera nella stessa scheda. */
  editionSuggestions: (id: string) =>
    request<BookSummary[]>(`/books/${id}/edition-suggestions`),
  addEdition: async (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<BookMeta>(`/books/${id}/editions`, { method: 'POST', body: form });
  },
  removeEdition: (id: string, file: string) =>
    request<BookMeta>(`/books/${id}/editions?file=${encodeURIComponent(file)}`, {
      method: 'DELETE',
    }),
  mergeBook: (id: string, otherId: string) =>
    request<{ book: BookMeta; folderRemoved: boolean; note?: string }>(`/books/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ otherId }),
    }),
  jellyfinInfo: () => request<JellyfinInfo>('/jellyfin/info'),
  jellyfinLibraries: () => request<JellyfinLibrary[]>('/jellyfin/libraries'),
  jellyfinPreview: (libraryId: string) =>
    request<JellyfinPreview>('/jellyfin/preview', {
      method: 'POST',
      body: JSON.stringify({ libraryId }),
    }),
  jellyfinImport: (libraryId: string) =>
    request<JellyfinImportState>('/jellyfin/import', {
      method: 'POST',
      body: JSON.stringify({ libraryId }),
    }),
  jellyfinImportState: () => request<JellyfinImportState | null>('/jellyfin/import'),
  folders: () => request<string[]>('/library/folders'),
  ao3Session: () => request<Ao3SessionState>('/ao3/session'),
  ao3Login: (username: string, password: string) =>
    request<Ao3SessionState>('/ao3/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  ao3Logout: () => request<Ao3SessionState>('/ao3/logout', { method: 'POST' }),
  fanficCheck: (all = false) =>
    request<FanficCheckState>('/fanfic-updates/check', { method: 'POST', body: JSON.stringify({ all }) }),
  fanficCheckState: () => request<FanficCheckState>('/fanfic-updates/status'),
  fanficUpdate: (id: string) => request<BookMeta>(`/books/${id}/fanfic-update`, { method: 'POST' }),
  fanficDismiss: (id: string) => request<BookMeta>(`/books/${id}/fanfic-update/dismiss`, { method: 'POST' }),
  createBook: (payload: { title: string; authors: string[]; kind: 'book' | 'fanfic' }) =>
    request<BookMeta>('/library/new', { method: 'POST', body: JSON.stringify(payload) }),
};
