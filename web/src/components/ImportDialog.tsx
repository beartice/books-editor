import { useEffect, useRef, useState } from 'react';
import { api, ApiError, tooLargeMessage } from '../api';
import type { EfpImportResult, JellyfinImportState, JellyfinLibrary, JellyfinPreview } from '../api';
import type { BookMeta, BookSummary, ConversionSupport } from '@shared/types';
import { syncAppleBooksFromApp } from '../desktop';
import { hideFanficsOf, libraryNameOf, useStore } from '../store';
import { cn, languageLabel } from '../utils';
import { IconClose, IconUpload } from './icons';

interface Props {
  onClose: () => void;
}

type DuplicateInfo = {
  reason: string;
  book: BookSummary;
  language?: string;
  existingLanguages?: string[];
};

type DuplicateDecision =
  | { action: 'force' }
  | { action: 'attach'; bookId: string; language: string }
  | { action: 'skip' }
  | { action: 'skipAll' };

/** Motivi con cui il server riconosce un duplicato. */
const DUPLICATE_REASONS: Record<string, string> = {
  file: 'stesso file',
  isbn: 'stesso ISBN',
  source: 'stessa fonte, stesso link',
  title: 'stesso titolo e autore',
};

/** Il duplicato descritto da un errore 409 del server, se e' quello il problema. */
function duplicateOf(error: unknown): DuplicateInfo | null {
  const body = error instanceof ApiError && error.status === 409 ? error.body : null;
  return (body as { duplicate?: DuplicateInfo } | null)?.duplicate ?? null;
}

// Estensioni sempre importabili; a queste si aggiungono quelle convertite dal server.
const BASE_EXTENSIONS = ['.epub', '.pdf', '.docx', '.txt', '.md', '.rtf'];

/** Un file scelto per l'import, con il percorso relativo alla cartella scelta (per il riepilogo). */
interface Candidate {
  file: File;
  path: string;
}

interface QueueEntry {
  name: string;
  reason: string;
}

interface QueueSummary {
  imported: number;
  attached: number;
  duplicates: QueueEntry[];
  errors: QueueEntry[];
  tooLarge: QueueEntry[];
  /** File di formato non importabile o nascosti, scartati senza avviso per file. */
  ignored: number;
  /** File rimasti fuori perche' la coda e' stata interrotta. */
  notDone: number;
}

interface QueueProgress {
  done: number;
  total: number;
  name: string;
  converting: boolean;
}

/** Il file o un'ancestrale della sua cartella e' nascosto (.DS_Store, ._nome, .git...). */
function isHiddenPath(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('.'));
}

/** Legge tutte le voci di una cartella: readEntries va richiamata finche' non torna vuota. */
async function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** Raccoglie ricorsivamente i file di una voce trascinata (file o cartella). */
async function collectEntry(entry: FileSystemEntry, out: Candidate[]): Promise<void> {
  const path = entry.fullPath.replace(/^\//, '');
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, path });
    return;
  }
  const children = await readDirectory((entry as FileSystemDirectoryEntry).createReader());
  for (const child of children) await collectEntry(child, out);
}

// webkitdirectory sui telefoni non e' affidabile: il pulsante cartella c'e' solo con mouse e tastiera.
const canPickFolder =
  typeof document !== 'undefined' &&
  'webkitdirectory' in document.createElement('input') &&
  !window.matchMedia('(pointer: coarse)').matches;

export default function ImportDialog({ onClose }: Props) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Formati convertiti dal server (MOBI, AZW3, FB2, DJVU...) e conversione in corso.
  const [conversion, setConversion] = useState<ConversionSupport | null>(null);
  const [converting, setConverting] = useState(false);
  // Import di piu' file (o di una cartella): avanzamento e riepilogo.
  const [progress, setProgress] = useState<QueueProgress | null>(null);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const stopRef = useRef(false);
  const queueRunning = progress !== null;
  const [efpUrl, setEfpUrl] = useState('');
  const [efpBusy, setEfpBusy] = useState<'import' | 'download' | null>(null);
  const { load, select, toast, confirm, settings, libraries } = useStore();
  const libraryName = useStore(libraryNameOf);
  const hideFanfics = useStore(hideFanficsOf);

  /** Aggiunta al testo del duplicato quando la scheda esistente e' una fanfiction nascosta. */
  const hiddenNote = (book: BookSummary) =>
    hideFanfics && book.kind === 'fanfic' ? ', fanfiction nascosta in questa libreria' : '';

  /** Se una fanfiction e' stata importata in una libreria che le nasconde, lo dice (la scheda esiste ma non si vede). */
  const hiddenFanficNotice = (kinds: Array<'book' | 'fanfic' | undefined>) =>
    hideFanfics && kinds.includes('fanfic')
      ? `Fanfiction importata: in «${libraryName}» le fanfiction sono nascoste (Impostazioni → Mostra le fanfiction)`
      : null;

  // Jellyfin: librerie, analisi e job di import in background.
  const jellyfinReady = Boolean(settings?.jellyfinUrl && settings?.jellyfinApiKeySet);
  const [jfLibraries, setJfLibraries] = useState<JellyfinLibrary[]>([]);
  const [jfLibraryId, setJfLibraryId] = useState('');
  const [jfPreview, setJfPreview] = useState<JellyfinPreview | null>(null);
  const [jfBusy, setJfBusy] = useState<'libraries' | 'preview' | null>(null);
  const [jfJob, setJfJob] = useState<JellyfinImportState | null>(null);

  useEffect(() => {
    api.conversion().then(setConversion).catch(() => undefined);
  }, []);

  // Carica le librerie Jellyfin e recupera un eventuale job ancora in corso.
  useEffect(() => {
    if (!jellyfinReady) return;
    setJfBusy('libraries');
    api
      .jellyfinLibraries()
      .then((libraries) => {
        setJfLibraries(libraries);
        setJfLibraryId((current) => current || libraries[0]?.id || '');
      })
      .catch((error) => toast((error as Error).message, 'error'))
      .finally(() => setJfBusy(null));
    api
      .jellyfinImportState()
      .then((state) => {
        if (state?.running) setJfJob(state);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jellyfinReady]);

  // Finche' il job gira, ne interroga lo stato ogni 1,5 secondi.
  const jfRunning = jfJob?.running ?? false;
  useEffect(() => {
    if (!jfRunning) return;
    const timer = setInterval(() => {
      api
        .jellyfinImportState()
        .then(async (state) => {
          if (!state) return;
          setJfJob(state);
          if (state.running) return;
          await load();
          void syncAppleBooksFromApp(state.imported.map((item) => item.id));
          const notice = hiddenFanficNotice(state.imported.map((item) => item.kind));
          if (notice) toast(notice, 'info');
          toast(
            `Importati ${state.imported.length}, aggiunte come altra lingua ${state.editions?.length ?? 0}, duplicati scartati ${state.duplicates.length}, errori ${state.errors.length}`,
            state.errors.length ? 'error' : 'success',
          );
          setJfPreview(null);
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jfRunning]);

  const analyzeJellyfin = async () => {
    if (!jfLibraryId) return;
    setJfBusy('preview');
    setJfPreview(null);
    try {
      setJfPreview(await api.jellyfinPreview(jfLibraryId));
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setJfBusy(null);
    }
  };

  const startJellyfin = async () => {
    if (!jfLibraryId) return;
    try {
      setJfJob(await api.jellyfinImport(jfLibraryId));
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  /**
   * Chiede cosa fare di un duplicato (409) con una notifica.
   * Restituisce 'force' per importare comunque, 'attach' (con l'id della scheda)
   * per aggiungere il file come altra lingua, altrimenti null (gestito).
   * Nell'import di piu' file (`batch`) non si apre la scheda esistente e si puo' saltare
   * il file ('skip') o tutti i duplicati successivi ('skipAll'); chiudere la domanda salta il file.
   */
  const askDuplicate = async (
    error: unknown,
    batch?: { fileName: string },
  ): Promise<DuplicateDecision | null> => {
    const duplicate = duplicateOf(error);
    if (!duplicate) {
      toast((error as Error).message, 'error');
      return null;
    }
    const { book, reason } = duplicate;
    const authors = book.authors?.length ? ` di ${book.authors.join(', ')}` : '';
    const prefix = batch ? `${batch.fileName}: ` : '';
    const skipActions = batch
      ? [
          { label: 'Salta', value: 'skip' },
          { label: 'Salta tutti i prossimi', value: 'skipAll' },
        ]
      : [{ label: 'Annulla', value: 'cancel' }];

    // Stessa opera in un'altra lingua: si puo' aggiungere come edizione.
    if (reason === 'language' && duplicate.language) {
      const existing = (duplicate.existingLanguages ?? []).map(languageLabel).join(', ');
      const language = languageLabel(duplicate.language);
      const answer = await confirm(
        `${prefix}«${book.title}»${authors} è già nella libreria (${existing}). Questo file è in ${language}: vuoi aggiungerlo come altra lingua?`,
        [
          { label: `Aggiungi come ${language}`, value: 'attach', primary: true },
          { label: 'Importa come libro separato', value: 'force' },
          ...skipActions,
        ],
      );
      if (answer === 'attach') return { action: 'attach', bookId: book.id, language };
      if (answer === 'force') return { action: 'force' };
      if (batch) return { action: answer === 'skipAll' ? 'skipAll' : 'skip' };
      return null;
    }

    const answer = await confirm(
      `${prefix}«${book.title}»${authors} è già nella libreria (${DUPLICATE_REASONS[reason] ?? reason}${hiddenNote(book)}). Vuoi importarlo di nuovo?`,
      [
        { label: 'Importa comunque', value: 'force', primary: true },
        ...(batch ? [] : [{ label: 'Apri esistente', value: 'open' }]),
        ...skipActions,
      ],
    );
    if (answer === 'force') return { action: 'force' };
    if (batch) return { action: answer === 'skipAll' ? 'skipAll' : 'skip' };
    if (answer === 'open') {
      onClose();
      await select(book.id);
    }
    return null;
  };

  const runImport = async (
    action: (options: { force?: boolean; attachTo?: string }) => Promise<BookMeta>,
  ) => {
    setBusy(true);
    try {
      let options: { force?: boolean; attachTo?: string } = {};
      let attachedLanguage = '';
      let imported: BookMeta | null = null;
      while (true) {
        try {
          imported = await action(options);
          break;
        } catch (error) {
          // Durante l'attesa della conferma la finestra non resta occupata.
          setBusy(false);
          const decision = await askDuplicate(error);
          if (!decision) return;
          if (decision.action !== 'force' && decision.action !== 'attach') return;
          options =
            decision.action === 'force' ? { force: true } : { attachTo: decision.bookId };
          attachedLanguage = decision.action === 'attach' ? decision.language : '';
          setBusy(true);
        }
      }
      await load();
      if (imported) void syncAppleBooksFromApp([imported.id]);
      const notice = imported ? hiddenFanficNotice([imported.kind]) : null;
      if (notice) toast(notice, 'info');
      else toast(attachedLanguage ? `Aggiunto come ${attachedLanguage}` : 'Opera importata', 'success');
      onClose();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importFromPath = async (value: string) => {
    if (!value.trim()) return;
    await runImport((options) => api.importPath(value.trim(), options));
  };

  // «MOBI / AZW3 / FB2 / DJVU…»: un'etichetta per formato, senza ripetere le varianti.
  const conversionLabels = [
    ...new Set(
      (conversion?.extensions ?? [])
        .filter((ext) => ext !== '.prc' && ext !== '.azw')
        .map((ext) => (ext === '.djv' ? 'DJVU' : ext.slice(1).toUpperCase())),
    ),
  ];
  const formatList = ['EPUB', 'PDF', 'DOCX', 'TXT', ...conversionLabels].join(' / ');

  const extensionOf = (name: string) => {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
  };
  const importableExtensions = [...BASE_EXTENSIONS, ...(conversion?.extensions ?? [])];

  const upload = async (file: File) => {
    // Se il limite del server e' noto, si evita di caricare un file che verrebbe rifiutato.
    if (settings?.maxUploadMb && file.size > settings.maxUploadMb * 1024 * 1024) {
      toast(tooLargeMessage(), 'error');
      return;
    }
    // Un formato da convertire puo' richiedere minuti: la risposta arriva a conversione finita.
    setConverting(Boolean(conversion?.extensions.includes(extensionOf(file.name))));
    try {
      await runImport((options) => api.uploadFile(file, options));
    } finally {
      setConverting(false);
    }
  };

  /**
   * Importa piu' file in coda, uno alla volta (le conversioni lato server sono in serie).
   * Un file che fallisce non ferma la coda; la lista si ricarica e Apple Books si
   * sincronizza una volta sola, alla fine.
   */
  const runQueue = async (picked: Candidate[]) => {
    const result: QueueSummary = {
      imported: 0,
      attached: 0,
      duplicates: [],
      errors: [],
      tooLarge: [],
      ignored: 0,
      notDone: 0,
    };
    const limit = settings?.maxUploadMb ? settings.maxUploadMb * 1024 * 1024 : 0;
    const queue: Candidate[] = [];
    for (const item of picked) {
      if (isHiddenPath(item.path) || !importableExtensions.includes(extensionOf(item.file.name))) {
        result.ignored += 1;
      } else if (limit && item.file.size > limit) {
        result.tooLarge.push({
          name: item.path,
          reason: `supera il limite di ${settings?.maxUploadMb} MB`,
        });
      } else {
        queue.push(item);
      }
    }
    setSummary(null);

    // Un solo file: stesso flusso del file singolo, senza coda.
    if (queue.length === 1 && result.tooLarge.length === 0 && result.ignored === 0) {
      await upload(queue[0].file);
      return;
    }
    if (queue.length === 0) {
      setSummary(result);
      return;
    }

    // Con piu' file, la scelta sui duplicati si fa una volta sola.
    let policy: 'skip' | 'force' | 'ask' = 'skip';
    if (queue.length > 1) {
      const answer = await confirm(
        `Importare ${queue.length} file. Se alcuni sono già nella libreria, cosa faccio?`,
        [
          { label: 'Salta i duplicati', value: 'skip', primary: true },
          { label: 'Importa comunque i duplicati', value: 'force' },
          { label: 'Chiedi ogni volta', value: 'ask' },
          { label: 'Annulla', value: 'cancel' },
        ],
      );
      if (answer !== 'skip' && answer !== 'force' && answer !== 'ask') return;
      policy = answer;
    }

    stopRef.current = false;
    let skipAll = false;
    const importedBooks: BookMeta[] = [];
    try {
      for (let index = 0; index < queue.length; index += 1) {
        if (stopRef.current) {
          result.notDone = queue.length - index;
          break;
        }
        const { file, path } = queue[index];
        setProgress({
          done: index,
          total: queue.length,
          name: path,
          converting: Boolean(conversion?.extensions.includes(extensionOf(file.name))),
        });
        let options: { force?: boolean; attachTo?: string } = {};
        let attached = false;
        while (true) {
          try {
            importedBooks.push(await api.uploadFile(file, options));
            result.imported += 1;
            if (attached) result.attached += 1;
            break;
          } catch (error) {
            const duplicate = duplicateOf(error);
            // Un errore vero (formato rotto, DRM, conversione) o un duplicato anche con «importa comunque».
            if (!duplicate || options.force || options.attachTo) {
              result.errors.push({ name: path, reason: (error as Error).message });
              break;
            }
            const why =
              duplicate.reason === 'language'
                ? `altra lingua di «${duplicate.book.title}»`
                : `${DUPLICATE_REASONS[duplicate.reason] ?? duplicate.reason}: «${duplicate.book.title}»`;
            let decision: DuplicateDecision | null = null;
            if (skipAll || policy === 'skip') decision = { action: 'skip' };
            else if (policy === 'force') decision = { action: 'force' };
            else decision = await askDuplicate(error, { fileName: path });
            if (decision?.action === 'skipAll') skipAll = true;
            if (!decision || decision.action === 'skip' || decision.action === 'skipAll') {
              result.duplicates.push({ name: path, reason: why });
              break;
            }
            options =
              decision.action === 'force' ? { force: true } : { attachTo: decision.bookId };
            attached = decision.action === 'attach';
          }
        }
      }
    } finally {
      setProgress(null);
      setSummary(result);
    }
    if (importedBooks.length > 0) {
      await load();
      void syncAppleBooksFromApp(importedBooks.map((book) => book.id));
      const notice = hiddenFanficNotice(importedBooks.map((book) => book.kind));
      if (notice) toast(notice, 'info');
    }
  };

  /** File scelti con gli input: la cartella porta con se' il percorso relativo. */
  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    void runQueue(
      Array.from(list).map((file) => ({ file, path: file.webkitRelativePath || file.name })),
    );
  };

  /** File e cartelle trascinati: le cartelle si leggono in profondita'. */
  const dropItems = async (data: DataTransfer) => {
    // Le voci vanno prese subito: finito l'evento il DataTransfer si svuota.
    const entries = Array.from(data.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.webkitGetAsEntry?.() ?? null);
    const plain = Array.from(data.files ?? []);
    const found: Candidate[] = [];
    try {
      if (entries.length > 0 && entries.every(Boolean)) {
        for (const entry of entries) await collectEntry(entry as FileSystemEntry, found);
      } else {
        found.push(...plain.map((file) => ({ file, path: file.name })));
      }
    } catch (error) {
      toast(`Non riesco a leggere la cartella: ${(error as Error).message}`, 'error');
      return;
    }
    if (found.length === 0) {
      toast('Nessun file da importare', 'info');
      return;
    }
    await runQueue(found);
  };

  const importEfp = async () => {
    const value = efpUrl.trim();
    if (!value) return;
    setEfpBusy('import');
    try {
      let mode: 'update' | 'new' | undefined;
      let result: EfpImportResult | null = null;
      while (!result) {
        try {
          result = await api.importEfp(value, mode);
        } catch (error) {
          const body =
            error instanceof ApiError && error.status === 409
              ? (error.body as {
                  duplicate?: { reason: string; book: BookSummary };
                  canUpdate?: boolean;
                } | null)
              : null;
          if (!body?.duplicate) throw error;
          // Storia gia' presente: si chiede se aggiornarla o importarla come copia.
          const { book, reason } = body.duplicate;
          const reasons: Record<string, string> = {
            source: 'stessa storia EFP',
            title: 'stesso titolo e autore',
          };
          const authors = book.authors?.length ? ` di ${book.authors.join(', ')}` : '';
          const answer = await confirm(
            `«${book.title}»${authors} è già nella libreria (${reasons[reason] ?? reason}${hiddenNote(book)}).`,
            body.canUpdate
              ? [
                  { label: 'Aggiorna la storia esistente', value: 'update', primary: true },
                  { label: 'Importa come nuova copia', value: 'new' },
                  { label: 'Annulla', value: 'cancel' },
                ]
              : [
                  { label: 'Importa comunque', value: 'new', primary: true },
                  { label: 'Annulla', value: 'cancel' },
                ],
          );
          if (answer !== 'update' && answer !== 'new') return;
          mode = answer;
        }
      }
      await load();
      void syncAppleBooksFromApp([result.book.id]);
      toast(
        `${result.created ? 'Storia importata' : 'Storia aggiornata'}: "${result.book.title}" · ${result.chapters} capitoli`,
        'success',
      );
      const notice = hiddenFanficNotice([result.book.kind]);
      if (notice) toast(notice, 'info');
      await select(result.book.id);
      onClose();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setEfpBusy(null);
    }
  };

  const downloadEfp = async () => {
    const value = efpUrl.trim();
    if (!value) return;
    setEfpBusy('download');
    try {
      const { blob, filename } = await api.downloadEfp(value, 'odt');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Documento ODT scaricato', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setEfpBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink-950/25 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div className="relative h-[100dvh] w-full max-w-lg animate-scale-in overflow-y-auto border-black/[0.07] bg-white p-5 shadow-panel sm:h-auto sm:max-h-[90vh] sm:rounded-[24px] sm:border sm:p-6">
        <div className="sticky top-0 z-10 -mx-5 -mt-5 mb-4 flex items-center justify-between bg-white px-5 py-3 sm:static sm:mx-0 sm:mt-0 sm:px-0 sm:py-0">
          <h2 className="text-lg font-semibold text-ink-50">
            {libraries.length > 1 ? `Importa in «${libraryName}»` : 'Importa un\'opera'}
          </h2>
          <button onClick={onClose} className="btn-subtle h-10 w-10 px-0 sm:h-auto sm:w-auto sm:px-2" aria-label="Chiudi">
            <IconClose />
          </button>
        </div>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!queueRunning) void dropItems(event.dataTransfer);
          }}
          onClick={() => document.getElementById('import-file')?.click()}
          className={cn(
            queueRunning && 'pointer-events-none opacity-50',
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition',
            dragging
              ? 'border-accent-500 bg-accent-500/10'
              : 'border-black/[0.10] bg-ink-800 hover:border-accent-500/50 hover:bg-accent-500/5',
          )}
        >
          <IconUpload className="h-6 w-6 text-ink-400" />
          <p className="text-sm text-ink-200">
            Trascina qui file o cartelle {formatList}
          </p>
          <p className="text-[11px] text-ink-500">
            {converting
              ? 'Conversione in corso… può richiedere qualche minuto'
              : conversionLabels.length > 0
                ? 'oppure clicca per sceglierlo · i formati Kindle e DJVU vengono convertiti'
                : 'oppure clicca per sceglierlo'}
          </p>
          <input
            id="import-file"
            type="file"
            accept={importableExtensions.join(',')}
            multiple
            hidden
            onChange={(event) => {
              pickFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>

        {canPickFolder && (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => document.getElementById('import-folder')?.click()}
              disabled={queueRunning || busy}
              className="btn-ghost px-3 py-1.5 text-[12px]"
            >
              Scegli una cartella
            </button>
            <span className="text-[11px] text-ink-500">con le sottocartelle</span>
            <input
              id="import-folder"
              type="file"
              // @ts-expect-error webkitdirectory non e' nei tipi di React
              webkitdirectory=""
              multiple
              hidden
              onChange={(event) => {
                pickFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </div>
        )}

        {progress && (
          <div className="mt-3 rounded-xl border border-black/[0.07] bg-ink-800 p-3" data-testid="import-progress">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-[12px] text-ink-200">
                {Math.min(progress.done + 1, progress.total)} di {progress.total} · {progress.name}
              </p>
              <button
                onClick={() => {
                  stopRef.current = true;
                }}
                className="btn-ghost shrink-0 px-3 py-1 text-[12px]"
              >
                Interrompi
              </button>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.08]">
              <div
                className="h-full bg-accent-500 transition-all"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
            {progress.converting && (
              <p className="mt-1 text-[11px] text-ink-500">Conversione in corso… può richiedere qualche minuto</p>
            )}
          </div>
        )}

        {summary && !progress && (
          <div className="mt-3 rounded-xl border border-black/[0.07] bg-ink-800 p-3" data-testid="import-summary">
            <p className="text-[12px] font-medium text-ink-100">
              Importati {summary.imported}
              {summary.attached > 0 ? ` (di cui ${summary.attached} come altra lingua)` : ''} · Duplicati
              saltati {summary.duplicates.length} · Errori {summary.errors.length} · Troppo grandi{' '}
              {summary.tooLarge.length}
            </p>
            {(summary.notDone > 0 || summary.ignored > 0) && (
              <p className="mt-0.5 text-[11px] text-ink-500">
                {summary.notDone > 0 ? `Interrotto: ${summary.notDone} file non importati. ` : ''}
                {summary.ignored > 0
                  ? `${summary.ignored} file nascosti o di formato non importabile ignorati.`
                  : ''}
              </p>
            )}
            {summary.duplicates.length + summary.errors.length + summary.tooLarge.length > 0 && (
              <details className="mt-1 text-[11px] text-ink-400">
                <summary className="cursor-pointer">File saltati o falliti</summary>
                <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-black/[0.06] bg-white p-2">
                  {[
                    ...summary.errors.map((item) => ({ ...item, kind: 'Errore' })),
                    ...summary.tooLarge.map((item) => ({ ...item, kind: 'Troppo grande' })),
                    ...summary.duplicates.map((item) => ({ ...item, kind: 'Duplicato' })),
                  ].map((item, i) => (
                    <div key={i} className="break-words">
                      <span className="text-ink-200">{item.kind}</span> {item.name}: {item.reason}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        <div className="mt-4 rounded-xl border border-accent-500/20 bg-accent-500/[0.04] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
              Da EFP Fanfiction
            </span>
            <span className="rounded-full bg-accent-500/10 px-2 py-0.5 text-[10px] font-medium text-accent-500">
              tutti i capitoli
            </span>
          </div>
          <input
            value={efpUrl}
            onChange={(event) => setEfpUrl(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && importEfp()}
            placeholder="https://www.efpfanfic.net/viewstory.php?sid=…"
            className="field-input text-[12px]"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={importEfp}
              disabled={efpBusy !== null || !efpUrl.trim()}
              className="btn-primary px-3 py-1.5 text-[12px]"
            >
              {efpBusy === 'import' ? 'Scarico…' : 'Importa nella libreria'}
            </button>
            <button
              onClick={downloadEfp}
              disabled={efpBusy !== null || !efpUrl.trim()}
              className="btn-ghost px-3 py-1.5 text-[12px]"
            >
              {efpBusy === 'download' ? 'Scarico…' : 'Scarica ODT'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-ink-500">
            L’import crea EPUB e ODT nella cartella del libro; “Scarica ODT” salva il documento
            sul computer.
          </p>
        </div>

        <div className="mt-4 rounded-xl border border-accent-500/20 bg-accent-500/[0.04] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
              Da Jellyfin
            </span>
            <span className="rounded-full bg-accent-500/10 px-2 py-0.5 text-[10px] font-medium text-accent-500">
              senza duplicati
            </span>
          </div>
          {!jellyfinReady ? (
            <p className="text-[11px] text-ink-500">
              Indirizzo o chiave API di Jellyfin mancanti: configurali nelle Impostazioni.
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <select
                  value={jfLibraryId}
                  onChange={(event) => {
                    setJfLibraryId(event.target.value);
                    setJfPreview(null);
                  }}
                  disabled={jfBusy !== null || jfRunning}
                  className="field-input text-[12px]"
                >
                  {jfLibraries.map((library) => (
                    <option key={library.id} value={library.id}>
                      {library.name}
                      {library.type === 'books' ? '' : ` (${library.type || 'altro'})`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={analyzeJellyfin}
                  disabled={jfBusy !== null || jfRunning || !jfLibraryId}
                  className="btn-ghost px-3 py-1.5 text-[12px]"
                >
                  {jfBusy === 'preview' ? 'Analizzo…' : 'Analizza'}
                </button>
              </div>

              {jfPreview && !jfRunning && (
                <div className="mt-2">
                  <p className="text-[12px] text-ink-200">
                    {jfPreview.counts.new} nuovi
                    {jfPreview.counts.uncertain > 0
                      ? ` (${jfPreview.counts.uncertain} da verificare dopo il download)`
                      : ''}{' '}
                    · {jfPreview.counts.duplicate} già presenti ·{' '}
                    {jfPreview.counts.unsupported} formati non supportati ·{' '}
                    {jfPreview.counts.imported} già importati
                  </p>
                  {(jfPreview.counts.new > 0 || jfPreview.counts.duplicate > 0) && (
                    <details className="mt-1 text-[11px] text-ink-400">
                      <summary className="cursor-pointer">Elenco</summary>
                      <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-black/[0.06] bg-ink-800 p-2">
                        {jfPreview.items
                          .filter((item) => item.status === 'new' || item.status === 'duplicate')
                          .map((item) => (
                            <div key={item.id} className="truncate">
                              <span className="text-ink-200">
                                {item.status === 'new' ? 'Nuovo' : 'Duplicato'}
                              </span>{' '}
                              {item.title}
                              {item.authors.length ? ` · ${item.authors.join(', ')}` : ''}
                              {item.status === 'duplicate'
                                ? item.reason === 'jellyfin-copy'
                                  ? ' (copia nella libreria Jellyfin)'
                                  : item.existing
                                    ? ` (già in libreria: «${item.existing.title}»)`
                                    : ''
                                : ''}
                              {item.status === 'new' && item.uncertain ? ' (da verificare)' : ''}
                            </div>
                          ))}
                      </div>
                    </details>
                  )}
                  <button
                    onClick={startJellyfin}
                    disabled={jfPreview.counts.new === 0}
                    className="btn-primary mt-2 px-3 py-1.5 text-[12px]"
                  >
                    Importa {jfPreview.counts.new} libri
                  </button>
                </div>
              )}

              {jfJob && (
                <div className="mt-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.08]">
                    <div
                      className="h-full bg-accent-500 transition-all"
                      style={{
                        width: `${jfJob.total ? Math.round((jfJob.done / jfJob.total) * 100) : 100}%`,
                      }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-ink-400">
                    {jfJob.running ? 'Importo… ' : 'Terminato · '}
                    {jfJob.done}/{jfJob.total} · importati {jfJob.imported.length} · aggiunte come
                    altra lingua: {jfJob.editions?.length ?? 0} · duplicati scartati {jfJob.duplicates.length} · errori {jfJob.errors.length}
                  </p>
                  {jfJob.errors.length > 0 && (
                    <div className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-[11px] text-rose-600/90">
                      {jfJob.errors.map((item, i) => (
                        <div key={i}>
                          {item.title}: {item.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-ink-500">
          <span className="h-px flex-1 bg-black/[0.07]" />
          oppure
          <span className="h-px flex-1 bg-black/[0.07]" />
        </div>

        <label className="block">
          <span className="field-label">Percorso sul server</span>
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && importFromPath(path)}
              placeholder="/home/utente/Scaricati/il-mio-ebook.epub"
              className="field-input font-mono text-[12px]"
            />
            <button onClick={() => importFromPath(path)} disabled={busy} className="btn-ghost">
              Importa
            </button>
          </div>
          <span className="mt-1 block text-[11px] text-ink-500">
            Il percorso è relativo al filesystem del server, non al tuo computer.
          </span>
        </label>

        <div className="mt-5 flex items-center justify-between border-t border-black/[0.06] pt-4">
          <p className="text-[11px] text-ink-500">
            Radice libreria: <span className="font-mono">{settings?.libraryRoot}</span>
          </p>
          <button onClick={onClose} className="btn-ghost">
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
