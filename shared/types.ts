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

/** Posizione di lettura salvata dal lettore integrato. */
export interface ReadingPosition {
  location: string;
  /** Percentuale 0-100. */
  progress: number;
  updatedAt: string;
}

/** Esito dell'ultimo controllo dei nuovi capitoli di una fanfiction (AO3, EFP). */
export interface FanficUpdate {
  /** Momento del controllo (ISO 8601). */
  checkedAt: string;
  /** Capitoli pubblicati sul sito, null se non letti. */
  remoteChapters: number | null;
  /** Capitoli previsti dall'autore (la Y di «7/10»), null se «?» o sconosciuti. */
  remoteTotal: number | null;
  remoteComplete: boolean;
  /** Data dell'ultimo aggiornamento sul sito, se la pagina la indica. */
  remoteUpdated: string | null;
  /** Capitoli in piu' rispetto alla scheda. */
  newChapters: number;
  /** La storia e' stata completata sul sito e la scheda la ha ancora in corso. */
  completed: boolean;
  /** Motivo per cui l'ultimo controllo non e' riuscito (accesso richiesto, opera cancellata...). */
  error: string | null;
  /** Numero di capitoli remoti per cui l'utente ha scelto «Ignora». */
  dismissedChapters?: number | null;
}

/** true se c'e' un aggiornamento da segnalare e l'utente non lo ha gia' ignorato. */
export function isFanficUpdateAvailable(update: FanficUpdate | null | undefined): boolean {
  if (!update) return false;
  if (update.newChapters <= 0 && !update.completed) return false;
  return update.remoteChapters !== (update.dismissedChapters ?? undefined);
}

/** Stato dell'invio dei metadati di una scheda a Jellyfin. Gestito solo dal server. */
export interface JellyfinSyncInfo {
  /** Elementi Jellyfin abbinati alla scheda (file principale ed edizioni). */
  itemIds: string[];
  /** Ultimo invio riuscito (ISO 8601), null se mai inviata. */
  pushedAt: string | null;
  /** Impronta della copertina inviata: la copertina non si rimanda se non cambia. */
  coverHash: string | null;
  /** Impronta dei metadati inviati: se non cambia non si rimanda nulla. */
  payloadHash?: string | null;
  /** Ultima verifica (anche senza invio, perche' nulla era cambiato). */
  checkedAt?: string | null;
  /** Motivo dell'ultimo invio fallito, null se andato a buon fine. */
  error: string | null;
}

/** Elemento di Jellyfin che non corrisponde a nessuna scheda. */
export interface JellyfinUnmatchedItem {
  id: string;
  name: string;
  /** Percorso come lo vede Jellyfin. */
  path: string;
  /** Perche' non e' abbinato. */
  reason: 'unknown' | 'unmapped';
}

/** Stato della sincronizzazione con Jellyfin (abbinamento e invio dei metadati). */
export interface JellyfinSyncState {
  /** Indirizzo, chiave e libreria Jellyfin dei libri sono impostati. */
  configured: boolean;
  /** Invio automatico attivo. */
  pushEnabled: boolean;
  /** Mappatura dei percorsi (JELLYFIN_PATH_MAP) presente. */
  pathMapSet: boolean;
  running: boolean;
  /** Fase del giro in corso. */
  phase: 'ignore' | 'match' | 'push' | null;
  done: number;
  total: number;
  /** Schede inviate, saltate perche' invariate, fallite nel giro (in corso o ultimo). */
  pushed: number;
  skipped: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Ultimo giro che ha toccato Jellyfin (inizio dell'ultimo abbinamento). */
  matchedAt: string | null;
  /** Schede con almeno un elemento Jellyfin. */
  matchedBooks: number;
  /** Schede abbinate il cui ultimo invio e' fallito. */
  booksWithError: number;
  /** Elementi Jellyfin letti nell'ultimo abbinamento. */
  jellyfinItems: number;
  /** Elementi di file secondari (originali, extra) senza scheda propria. */
  secondaryItems: number;
  unmatchedCount: number;
  /** Primi elementi senza scheda (al massimo 200). */
  unmatched: JellyfinUnmatchedItem[];
  /** Ultimo invio riuscito a Jellyfin (qualunque scheda). */
  lastPushAt: string | null;
  /** Ultima richiesta di aggiornamento della libreria a Jellyfin. */
  lastScanAt: string | null;
  /** Errore generale dell'ultimo giro (Jellyfin irraggiungibile, libreria mancante...). */
  error: string | null;
}

/** Sessione AO3 dell'utente (il server conserva solo i cookie, mai la password). */
export interface Ao3SessionState {
  loggedIn: boolean;
  username: string | null;
  loggedInAt: string | null;
  /** true se AO3 ha rifiutato la sessione: serve un nuovo accesso. */
  expired?: boolean;
}

/** Stato del giro di controllo degli aggiornamenti delle fanfiction. */
export interface FanficCheckState {
  running: boolean;
  /** Opere controllate finora e totale del giro in corso (o dell'ultimo). */
  done: number;
  total: number;
  /** Opere con un aggiornamento trovato. */
  found: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Fine dell'ultimo giro (salvata su disco), null se non e' mai stato fatto. */
  lastRunAt: string | null;
  /** Motivo per cui il giro si e' fermato prima della fine (limite di richieste). */
  stopReason: string | null;
  /** false se il controllo notturno e' disattivato (FANFIC_CHECK=off). */
  automatic: boolean;
  /** Ora locale del controllo notturno. */
  hour: number;
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
  /**
   * Originale da cui il file principale e' stato convertito (MOBI, AZW3, FB2,
   * DJVU...), relativo alla cartella del libro. Non e' una lingua ne' un file
   * extra: si scarica dal menu del libro. Gestito solo dal server.
   */
  originalFile?: string | null;
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
  /** Esito dell'ultimo controllo dei nuovi capitoli sul sito. Gestito solo dal server. */
  fanficUpdate?: FanficUpdate | null;
  /** Invio dei metadati a Jellyfin. Gestito solo dal server. */
  jellyfinSync?: JellyfinSyncInfo | null;

  /* --- campi personali --- */
  notes: string;
  /** Voto personale da 0,5 a 5, a mezze stelle (null = non valutato). */
  rating: number | null;
  favorite: boolean;
  readingStatus: ReadingStatus;
  /** Percentuale di lettura da 0 a 100 (null = non disponibile). */
  readingProgress: number | null;
  /** Momento dell'ultimo aggiornamento di `readingProgress`, da qualunque fonte (lettore, Apple Books, modifica a mano). */
  readingProgressUpdatedAt?: string | null;
  /**
   * Posizione di lettura nel lettore integrato, per file letto (nome del file, principale o edizione).
   * `location` e' il CFI per l'EPUB o il numero di pagina per il PDF.
   */
  readingPositions?: Record<string, ReadingPosition>;
  /** Data in cui il libro e' stato finito (AAAA-MM-GG), null se non finito. */
  dateFinished: string | null;
  /** Data in cui la lettura e' iniziata (AAAA-MM-GG): da Apple Books, dal lettore o a mano. */
  dateStarted?: string | null;
  /** Date di Apple Books per questo libro (ISO 8601, vuote se assenti). Gestito solo dal server. */
  appleDates?: AppleDates;

  dateAdded: string;
  dateModified: string;
  lastRead: string | null;

  /**
   * Provenienza di ogni campo: 'file' = estratto dal documento, 'manual' = edited
   * a mano, 'online' = preso da un provider esterno, 'ai' = inferito.
   */
  fieldSource: Record<string, string>;
}

/** Date che Apple Books conosce di un libro: servono a stimare l'inizio della lettura. */
export interface AppleDates {
  /** Aggiunta alla libreria di Apple Books. */
  addedAt: string;
  /** La piu' vecchia fra tutte le annotazioni, posizione di lettura compresa: prima apertura. */
  firstOpenedAt: string;
  /** Ultimo utilizzo del libro. */
  lastEngagedAt: string;
}

/** Formati che il server sa convertire in EPUB/PDF all'import, secondo gli strumenti installati. */
export interface ConversionSupport {
  calibre: boolean;
  djvu: boolean;
  /** Estensioni con il punto (".mobi", ".djvu"...). */
  extensions: string[];
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
  dateStarted?: string | null;
  favorite: boolean;
  publisher: string;
  language: string;
  description: string;
  isbn: string;
  /** Link AO3, usato per cercare le altre opere della serie. */
  ao3Url: string;
  /** Esito dell'ultimo controllo dei nuovi capitoli (vedi BookMeta.fanficUpdate). */
  fanficUpdate?: FanficUpdate | null;
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

/** Tutti i colori ammessi, per validare le richieste. */
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  'underline',
  'green',
  'blue',
  'yellow',
  'pink',
  'purple',
  'none',
];

/**
 * Una sottolineatura/evidenziazione con eventuale nota. Il formato e' volutamente
 * semplice: la fonte di verita' resta il `book.json` del libro.
 */
export interface BookHighlight {
  /** Identificatore stabile (UUID Apple Books) per import ripetuti senza duplicati. */
  id: string;
  /** 'reader' = creata nel lettore integrato; si modifica e si elimina da li'. */
  source: 'applebooks' | 'manual' | 'reader';
  /**
   * File del libro (`sourceFile` o un'edizione) su cui vale `location`. Assente per
   * quelle di Apple Books e per le vecchie: valgono per il file principale.
   */
  file?: string;
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

/** Riga grezza della tabella delle annotazioni di Apple Books. */
export interface AppleAnnotationRow {
  uuid?: string | null;
  assetId?: string | null;
  text?: string | null;
  note?: string | null;
  location?: string | null;
  style?: number | string | null;
  underline?: number | string | null;
  createdAt?: number | string | null;
  modifiedAt?: number | string | null;
}

/** Riga grezza della libreria di Apple Books. */
export interface AppleLibraryRow {
  assetId?: string | null;
  title?: string | null;
  sortTitle?: string | null;
  author?: string | null;
  sortAuthor?: string | null;
  /** Data di fine lettura (timestamp Core Data). */
  finishedAt?: number | string | null;
  /** Avanzamento di lettura da 0 a 1. */
  readingProgress?: number | string | null;
  /** Ultima apertura del libro in Apple Books (timestamp Core Data). */
  lastOpenedAt?: number | string | null;
  /** Aggiunta del libro ad Apple Books (timestamp Core Data). */
  addedAt?: number | string | null;
  /** Ultimo utilizzo del libro (timestamp Core Data). */
  lastEngagedAt?: number | string | null;
  /** Annotazione piu' vecchia di qualunque tipo, posizione di lettura compresa (timestamp Core Data). */
  firstOpenedAt?: number | string | null;
}

/** Dati letti da Apple Books sul Mac, prima dell'abbinamento con la libreria. */
export interface AppleBooksRawData {
  database: string;
  annotations: AppleAnnotationRow[];
  library: AppleLibraryRow[];
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
  /** Libri abbinati con una data di inizio stimata da Apple Books. */
  startedDates?: number;
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
  /** Fanfiction nascoste nella libreria principale (si cambia da PATCH /api/libraries/main). */
  mainHideFanfics?: boolean;
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
  /** Libreria Jellyfin (di tipo libri) che legge la cartella delle librerie. */
  jellyfinBooksLibraryId?: string;
  /** Invia da solo a Jellyfin i metadati modificati (default: si, con la libreria impostata). */
  jellyfinPushEnabled?: boolean;
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
  { key: 'dateStarted', label: 'Iniziato il', group: 'extra', type: 'date' },
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
  /** Opere visibili (senza le fanfiction se sono nascoste). */
  bookCount: number;
  isMain: boolean;
  /** true se le fanfiction sono nascoste nell'interfaccia di questa libreria. */
  hideFanfics: boolean;
}

/* ------------------------------------------------ statistiche di lettura -- */

/** Un conteggio diviso fra libri e fanfiction. */
export interface KindSplit {
  total: number;
  books: number;
  fanfics: number;
}

/** Una lettura finita nel periodo (per la linea del tempo). */
export interface ReadingStatsRead {
  id: string;
  title: string;
  kind: BookKind;
  /** Inizio della lettura (AAAA-MM-GG), null se non noto. */
  start: string | null;
  /** Fine della lettura (AAAA-MM-GG). */
  end: string;
  /** Giorni fra inizio e fine (0 = stesso giorno), null se l'inizio e' ignoto. */
  days: number | null;
  rating: number | null;
}

export interface ReadingStatsBucket {
  key: 'same' | 'short' | 'week' | 'month' | 'long';
  label: string;
  count: number;
}

export interface ReadingStatsMonth {
  /** AAAA-MM */
  month: string;
  count: number;
  /** Giorni distinti con almeno una sottolineatura. */
  days: number;
}

/** Risposta di `GET /api/stats/reading`. */
export interface ReadingStats {
  /** Periodo richiesto. */
  year: number | 'all';
  /** Finestra dei grafici: l'anno scelto, oppure gli ultimi 12 mesi con `all` (AAAA-MM-GG). */
  window: { from: string; to: string; today: string };
  /** Ci sono fanfiction visibili? Se no, niente legenda e niente barre delle fanfiction. */
  hasFanfics: boolean;
  tiles: {
    /** Tutte le opere visibili, qualunque stato. */
    total: KindSplit;
    /** Stato attuale della libreria (non dipende dal periodo). */
    read: KindSplit;
    reading: KindSplit;
    dnf: KindSplit;
    unread: KindSplit;
    /** Opere lette nel periodo (con `all`: tutte le lette, anche senza data di fine). */
    period: {
      read: KindSplit;
      reread: number;
      words: number;
      /** Ore stimate (parole / (parole al minuto * 60)). */
      hours: number;
      averageRating: number | null;
      rated: number;
      fiveStars: number;
    };
  };
  /** Opere lette per anno di fine, dal piu' vecchio al piu' recente, senza buchi. */
  byYear: { year: number; books: number; fanfics: number }[];
  /** Quante opere lette hanno la data di fine, e quante sono lette in tutto. */
  withFinishDate: number;
  readTotal: number;
  reads: {
    /** Per data di fine crescente. */
    items: ReadingStatsRead[];
    count: KindSplit;
    /** Mediana dei giorni delle letture con inizio noto, null se nessuna. */
    medianDays: number | null;
    withStart: number;
    buckets: ReadingStatsBucket[];
    longest: ReadingStatsRead | null;
  };
  /** Sottolineature (Apple Books e lettore) per giorno, nella finestra. */
  highlightsByDay: Record<string, number>;
  highlightsByMonth: ReadingStatsMonth[];
  highlightsTotal: number;
  highlightsDays: number;
  recordDay: { date: string; count: number } | null;
  busiestMonth: ReadingStatsMonth | null;
  topHighlighted: { id: string; title: string; count: number }[];
  topAuthors: { name: string; count: number }[];
  /** Voti delle opere del periodo, da 0,5 a 5. */
  ratingDistribution: { value: number; count: number }[];
  genres: { genre: string; count: number }[];
  reading: {
    total: number;
    items: { id: string; title: string; kind: BookKind; progress: number }[];
  };
  /** Opere aggiunte nella finestra (data di Apple Books se c'e', altrimenti `dateAdded`). */
  added: { total: number; byMonth: { month: string; count: number }[]; busiest: { month: string; count: number } | null };
}
