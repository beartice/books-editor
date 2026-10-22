/**
 * Tipi condivisi fra server e web.
 * Ogni entita' "libro" e' un record in `library/<cartella>/book.json`.
 */

export type BookKind = 'book' | 'fanfic';

export type BookFormat = 'epub' | 'pdf' | 'docx' | 'txt' | 'md' | 'rtf' | 'other';

/** dnf = "did not finish", lettura abbandonata. */
export type ReadingStatus = 'unread' | 'reading' | 'read' | 'reread' | 'dnf';

/** Ordine in cui gli stati compaiono nei menu e nei filtri. */
export const READING_STATUSES: readonly ReadingStatus[] = ['unread', 'reading', 'read', 'reread', 'dnf'];

/** Livello di affidabilita' di un dato estratto automaticamente. */
export type Confidence = 'high' | 'medium' | 'low';

/** Un'altra edizione (lingua) della stessa opera, oltre a quella principale. */
export interface BookEdition {
  /** File dell'edizione, relativo alla cartella del libro (e' anche in `extraFiles`). */
  file: string;
  /** Lingua ISO 639-1 ("it", "en"), vuota se non riconosciuta. */
  language: string;
  title: string;
}

export interface BookMeta {
  id: string;
  kind: BookKind;

  /** Percorso della cartella del libro, relativo alla root della libreria. */
  folder: string;
  /** File sorgente principale (epub/pdf/...), relativo alla cartella del libro. */
  sourceFile: string | null;
  format: BookFormat;
  /** Altri file presenti nella cartella (capitoli extra, arte, ecc.). */
  extraFiles: string[];
  /**
   * Altre lingue della stessa opera, oltre alla principale (`sourceFile`, con
   * `language` e `title`). Gestito solo dal server: non si modifica via PATCH.
   */
  editions?: BookEdition[];
  /** Copertina, relativa alla cartella del libro. */
  coverFile: string | null;

  title: string;
  subtitle: string;
  authors: string[];
  series: string;
  seriesIndex: number | null;
  /** Sottolineature/evidenziazioni importate (es. da Apple Books). */
  highlights: BookHighlight[];

  /* --- campi da libro (editoria) --- */
  publisher: string;
  publishedDate: string;
  language: string;
  isbn: string;
  /** Identificatori esterni: googlebooks, openlibrary, ao3, ffnet, ... */
  identifiers: Record<string, string>;
  description: string;
  pageCount: number | null;
  wordCount: number | null;
  charCount: number | null;

  /* --- campi da fanfiction --- */
  fandom: string;
  ships: string[];
  characters: string[];
  relationships: string[];
  /** Rating di contenuto: G, PG, PG-13, M, MA, ... */
  fanRating: string;
  tags: string[];
  /** Complete / Incomplete / Ongoing ... */
  status: string;
  chapters: number | null;
  ao3Url: string;
  ffnetUrl: string;
  /** Link della storia su EFP Fanfiction (efpfanfic.net). */
  efpUrl: string;

  /* --- campi personali --- */
  notes: string;
  /** Voto personale da 0,5 a 5, a mezze stelle (null = non valutato). */
  rating: number | null;
  favorite: boolean;
  readingStatus: ReadingStatus;
  /** Percentuale di lettura da 0 a 100 (null = non disponibile). */
  readingProgress: number | null;
  /** Data in cui il libro e' stato finito (AAAA-MM-GG), null se non finito. */
  dateFinished: string | null;

  dateAdded: string;
  dateModified: string;
  lastRead: string | null;

  /**
   * Provenienza di ogni campo: 'file' = estratto dal documento, 'manual' = edited
   * a mano, 'online' = preso da un provider esterno, 'ai' = inferito.
   */
  fieldSource: Record<string, string>;
}

export interface BookSummary {
  id: string;
  kind: BookKind;
  /** Edizioni in altre lingue (vedi BookMeta.editions). */
  editions?: BookEdition[];
  title: string;
  subtitle: string;
  authors: string[];
  series: string;
  seriesIndex: number | null;
  coverFile: string | null;
  folder: string;
  format: BookFormat;
  fandom: string;
  tags: string[];
  rating: number | null;
  fanRating: string;
  status: string;
  wordCount: number | null;
  pageCount: number | null;
  publishedDate: string;
  dateAdded: string;
  dateModified: string;
  lastRead: string | null;
  readingStatus: ReadingStatus;
  readingProgress: number | null;
  dateFinished: string | null;
  favorite: boolean;
  publisher: string;
  language: string;
  description: string;
  isbn: string;
  /** Link AO3, usato per cercare le altre opere della serie. */
  ao3Url: string;
}

/** Colore di una sottolineatura, come mostrato da Apple Books. */
export type HighlightColor =
  | 'underline'
  | 'green'
  | 'blue'
  | 'yellow'
  | 'pink'
  | 'purple'
  | 'none';

/**
 * Una sottolineatura/evidenziazione con eventuale nota. Il formato e' volutamente
 * semplice: la fonte di verita' resta il `book.json` del libro.
 */
export interface BookHighlight {
  /** Identificatore stabile (UUID Apple Books) per import ripetuti senza duplicati. */
  id: string;
  source: 'applebooks' | 'manual';
  text: string;
  note: string;
  color: HighlightColor;
  /** Posizione nel libro, ad esempio un EPUB CFI di Apple Books. */
  location: string;
  /** Capitolo/Sezione ricavati dalla posizione, quando riconoscibili. */
  chapter: string;
  /** Data ISO 8601, vuota se la fonte non la fornisce. */
  createdAt: string;
  modifiedAt: string;
}

export interface AppleBooksUnmatched {
  assetId: string;
  title: string;
  author: string;
  count: number;
}

export interface AppleBooksMatched {
  bookId: string;
  title: string;
  appleTitle: string;
  count: number;
  /** Data di fine lettura trovata in Apple Books (AAAA-MM-GG), vuota se assente. */
  finishedAt: string;
  /** Percentuale di lettura (0-100), null se assente. */
  readingProgress: number | null;
}

export interface AppleBooksImportResult {
  /** Percorso del database delle annotazioni usato per l'import. */
  database: string;
  /** Annotazioni valide (con testo) trovate in Apple Books. */
  annotations: number;
  /** Annotazioni scritte nei libri della libreria. */
  imported: number;
  /** Libri della libreria riconosciuti. */
  booksMatched: number;
  /** Libri effettivamente riscritti (diversi dagli abbinati se erano gia' aggiornati). */
  booksUpdated: number;
  /** Libri abbinati con una data di fine lettura affidabile. */
  finishedDates: number;
  /** Libri abbinati con una percentuale di lettura. */
  progressBooks: number;
  /** true se non e' stato scritto nulla (solo anteprima). */
  dryRun: boolean;
  matched: AppleBooksMatched[];
  unmatched: AppleBooksUnmatched[];
}

export interface LibraryStats {
  total: number;
  books: number;
  fanfics: number;
  words: number;
  withCover: number;
  missingMetadata: number;
  byFormat: Record<string, number>;
}

/** Un insieme di campi proposti da una fonte esterna (file locale o provider). */
export interface MetadataCandidate {
  provider: string;
  /** Etichetta leggibile: "Google Books", "Open Library", "File EPUB". */
  label: string;
  /** URL della pagina sorgente, se esiste. */
  url?: string | null;
  /** URL immagine della copertina candidata. */
  coverUrl?: string | null;
  /** Valori proposti (solo i campi effettivamente presenti). */
  fields: Partial<BookMeta>;
  /** Frammenti di testo usati per il confronto nell'interfaccia. */
  summary?: string | null;
}

export interface LookupResult {
  book?: BookSummary;
  candidates: MetadataCandidate[];
  /** Elenco dei campi vuoti che nessuna fonte puo' riempire. */
  missing: string[];
  /** Errori incontrati durante la ricerca (provider irraggiungibili). */
  errors: string[];
}

/** Un volume di una serie trovato online, usato per scoprire i libri mancanti. */
export interface SeriesVolume {
  /** Numero del volume nella serie, quando la fonte lo dichiara. */
  index: number | null;
  title: string;
  subtitle: string;
  authors: string[];
  /** Data di uscita normalizzata: AAAA-MM-GG, AAAA-MM oppure AAAA. */
  releaseDate: string;
  provider: string;
  providerLabel: string;
  url: string | null;
  coverUrl: string | null;
  isbn: string;
}

export interface SeriesLookupResult {
  volumes: SeriesVolume[];
  errors: string[];
}

export interface AppSettings {
  libraryRoot: string;
  /** Sola lettura: true se la cartella e' bloccata dalla variabile LIBRARY_ROOT. */
  libraryRootLocked?: boolean;
  /** Sola lettura: dimensione massima di un file caricato dal browser (MAX_UPLOAD_MB). */
  maxUploadMb?: number;
  libraryName: string;
  /** Lingua di default per i metadati cercati online. */
  searchLanguage: string;
  /** Provider abilitati per le ricerche online (Goodreads solo per le serie). */
  providers: string[];
  /** Compila automaticamente i metadati mancanti dai provider online. */
  autoLookup: boolean;
  /**
   * Chiave API di Google Books (facoltativa). Viene accettata in scrittura ma
   * non restituita dalle API: usare `googleBooksApiKeySet` per sapere se c'è.
   */
  googleBooksApiKey?: string;
  /** Sola lettura: true se una chiave Google Books è configurata. */
  googleBooksApiKeySet?: boolean;
  /** Sola lettura: true se la chiave arriva da GOOGLE_BOOKS_API_KEY. */
  googleBooksApiKeyEnvSet?: boolean;
  /** Indirizzo del server Jellyfin (es. https://jellyfin.esempio.it). */
  jellyfinUrl?: string;
  /** Chiave API di Jellyfin: accettata in scrittura, mai restituita. */
  jellyfinApiKey?: string;
  /** Sola lettura: true se una chiave Jellyfin e' configurata. */
  jellyfinApiKeySet?: boolean;
  /** Theme: 'dark' | 'light' | 'system'. */
  theme: 'dark' | 'light' | 'system';
  /** Numeri di parole per ora di lettura (per la stima del tempo). */
  wordsPerHour: number;
  /** Giorni dopo cui ricercare online le serie con volumi/opere mancanti. */
  seriesRefreshDays: number;
  /** Mostra i campi fanfiction anche sui libri e viceversa. */
  showAllFields: boolean;
}

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  errors: string[];
  scannedFolders: number;
}

export type SortKey =
  | 'title'
  | 'author'
  | 'series'
  | 'length'
  | 'dateAdded'
  | 'dateModified'
  | 'publishedDate'
  | 'rating'
  | 'fandom'
  | 'lastRead'
  | 'dateFinished'
  | 'readingProgress';

export interface SortOption {
  key: SortKey;
  label: string;
  asc: boolean;
}

export type FieldGroup = 'core' | 'book' | 'fanfic' | 'extra';

export interface FieldSpec {
  key: string;
  label: string;
  group: FieldGroup;
  type: 'text' | 'textarea' | 'number' | 'date' | 'list' | 'stars' | 'tags' | 'bool';
  placeholder?: string;
  help?: string;
  /** Applicabile solo a questo tipo di opera. */
  only?: BookKind;
}

/** Specifiche dei campi usate per generare i form dell'interfaccia. */
export const FIELD_SPECS: FieldSpec[] = [
  { key: 'title', label: 'Titolo', group: 'core', type: 'text', only: 'book' },
  { key: 'subtitle', label: 'Sottotitolo', group: 'core', type: 'text' },
  { key: 'authors', label: 'Autore/i', group: 'core', type: 'list' },
  { key: 'series', label: 'Serie', group: 'core', type: 'text' },
  { key: 'seriesIndex', label: 'Volume nella serie', group: 'core', type: 'number' },
  { key: 'kind', label: 'Tipo di opera', group: 'core', type: 'text', help: 'book o fanfic' },
  { key: 'description', label: 'Descrizione', group: 'core', type: 'textarea' },

  { key: 'publisher', label: 'Editore', group: 'book', type: 'text', only: 'book' },
  { key: 'publishedDate', label: 'Data di pubblicazione', group: 'book', type: 'date', only: 'book' },
  { key: 'language', label: 'Lingua', group: 'book', type: 'text' },
  { key: 'isbn', label: 'ISBN', group: 'book', type: 'text', only: 'book' },
  { key: 'pageCount', label: 'Pagine', group: 'book', type: 'number', only: 'book' },

  { key: 'fandom', label: 'Fandom', group: 'fanfic', type: 'text', only: 'fanfic' },
  { key: 'ships', label: 'Ship / Pairing', group: 'fanfic', type: 'list', only: 'fanfic' },
  { key: 'characters', label: 'Personaggi', group: 'fanfic', type: 'list', only: 'fanfic' },
  { key: 'relationships', label: 'Relazioni', group: 'fanfic', type: 'list', only: 'fanfic' },
  { key: 'fanRating', label: 'Rating contenuti', group: 'fanfic', type: 'text', only: 'fanfic' },
  { key: 'status', label: 'Stato', group: 'fanfic', type: 'text', only: 'fanfic' },
  { key: 'chapters', label: 'Capitoli', group: 'fanfic', type: 'number', only: 'fanfic' },
  { key: 'ao3Url', label: 'URL AO3', group: 'fanfic', type: 'text', only: 'fanfic' },
  { key: 'ffnetUrl', label: 'URL FanFiction.net', group: 'fanfic', type: 'text', only: 'fanfic' },
  { key: 'efpUrl', label: 'URL EFP', group: 'fanfic', type: 'text', only: 'fanfic' },

  { key: 'tags', label: 'Tag', group: 'extra', type: 'tags' },
  { key: 'notes', label: 'Note personali', group: 'extra', type: 'textarea' },
  { key: 'rating', label: 'Voto personale', group: 'extra', type: 'stars' },
  { key: 'favorite', label: 'Preferito', group: 'extra', type: 'bool' },
  { key: 'readingStatus', label: 'Lettura', group: 'extra', type: 'text' },
  { key: 'readingProgress', label: 'Avanzamento (%)', group: 'extra', type: 'number' },
  { key: 'dateFinished', label: 'Finito il', group: 'extra', type: 'date' },
  { key: 'folder', label: 'Cartella', group: 'extra', type: 'text' },
];

export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  FIELD_SPECS.map((f) => [f.key, f.label]),
);

/** Stato della scrittura su Apple Books per una scheda (solo macOS, libri importati). */
export interface AppleBooksWriteStatus {
  available: boolean;
  reason?: string;
  asset?: {
    assetId: string;
    path: string;
    /** Titolo e autore attuali in Apple Books. */
    title: string;
    author: string;
    coverFile?: string;
  };
}

export type AppleBooksWriteField = 'title' | 'authors' | 'cover';

/** Una libreria dell'account: la principale (id `main`) o una creata dall'utente. */
export interface LibrarySummary {
  id: string;
  name: string;
  bookCount: number;
  isMain: boolean;
}
