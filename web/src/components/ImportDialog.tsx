import { useEffect, useState } from 'react';
import { api, ApiError, tooLargeMessage } from '../api';
import type { JellyfinImportState, JellyfinLibrary, JellyfinPreview } from '../api';
import type { BookMeta, BookSummary } from '@shared/types';
import { syncAppleBooksFromApp } from '../desktop';
import { libraryNameOf, useStore } from '../store';
import { cn, languageLabel } from '../utils';
import { IconClose, IconUpload } from './icons';

interface Props {
  onClose: () => void;
}

export default function ImportDialog({ onClose }: Props) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [efpUrl, setEfpUrl] = useState('');
  const [efpBusy, setEfpBusy] = useState<'import' | 'download' | null>(null);
  const { load, select, toast, confirm, settings, libraries } = useStore();
  const libraryName = useStore(libraryNameOf);

  // Jellyfin: librerie, analisi e job di import in background.
  const jellyfinReady = Boolean(settings?.jellyfinUrl && settings?.jellyfinApiKeySet);
  const [jfLibraries, setJfLibraries] = useState<JellyfinLibrary[]>([]);
  const [jfLibraryId, setJfLibraryId] = useState('');
  const [jfPreview, setJfPreview] = useState<JellyfinPreview | null>(null);
  const [jfBusy, setJfBusy] = useState<'libraries' | 'preview' | null>(null);
  const [jfJob, setJfJob] = useState<JellyfinImportState | null>(null);

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
   * Se l'errore e' un duplicato (409) chiede conferma con una notifica.
   * Restituisce 'force' per importare comunque, 'attach' (con l'id della scheda)
   * per aggiungere il file come altra lingua, altrimenti null (gestito).
   */
  const askDuplicate = async (
    error: unknown,
  ): Promise<{ action: 'force' } | { action: 'attach'; bookId: string; language: string } | null> => {
    const body = error instanceof ApiError && error.status === 409 ? error.body : null;
    const duplicate = (
      body as {
        duplicate?: {
          reason: string;
          book: BookSummary;
          language?: string;
          existingLanguages?: string[];
        };
      } | null
    )?.duplicate;
    if (!duplicate) {
      toast((error as Error).message, 'error');
      return null;
    }
    const { book, reason } = duplicate;
    const authors = book.authors?.length ? ` di ${book.authors.join(', ')}` : '';

    // Stessa opera in un'altra lingua: si puo' aggiungere come edizione.
    if (reason === 'language' && duplicate.language) {
      const existing = (duplicate.existingLanguages ?? []).map(languageLabel).join(', ');
      const language = languageLabel(duplicate.language);
      const answer = await confirm(
        `«${book.title}»${authors} è già nella libreria (${existing}). Questo file è in ${language}: vuoi aggiungerlo come altra lingua?`,
        [
          { label: `Aggiungi come ${language}`, value: 'attach', primary: true },
          { label: 'Importa come libro separato', value: 'force' },
          { label: 'Annulla', value: 'cancel' },
        ],
      );
      if (answer === 'attach') return { action: 'attach', bookId: book.id, language };
      if (answer === 'force') return { action: 'force' };
      return null;
    }

    const reasons: Record<string, string> = {
      file: 'stesso file',
      isbn: 'stesso ISBN',
      title: 'stesso titolo e autore',
    };
    const answer = await confirm(
      `«${book.title}»${authors} è già nella libreria (${reasons[reason] ?? reason}). Vuoi importarlo di nuovo?`,
      [
        { label: 'Importa comunque', value: 'force', primary: true },
        { label: 'Apri esistente', value: 'open' },
        { label: 'Annulla', value: 'cancel' },
      ],
    );
    if (answer === 'force') return { action: 'force' };
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
          options =
            decision.action === 'force' ? { force: true } : { attachTo: decision.bookId };
          attachedLanguage = decision.action === 'attach' ? decision.language : '';
          setBusy(true);
        }
      }
      await load();
      if (imported) void syncAppleBooksFromApp([imported.id]);
      toast(attachedLanguage ? `Aggiunto come ${attachedLanguage}` : 'Opera importata', 'success');
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

  const upload = async (file: File) => {
    // Se il limite del server e' noto, si evita di caricare un file che verrebbe rifiutato.
    if (settings?.maxUploadMb && file.size > settings.maxUploadMb * 1024 * 1024) {
      toast(tooLargeMessage(), 'error');
      return;
    }
    await runImport((options) => api.uploadFile(file, options));
  };

  const importEfp = async () => {
    const value = efpUrl.trim();
    if (!value) return;
    setEfpBusy('import');
    try {
      const result = await api.importEfp(value);
      await load();
      void syncAppleBooksFromApp([result.book.id]);
      toast(
        `${result.created ? 'Importata' : 'Aggiornata'} "${result.book.title}" · ${result.chapters} capitoli`,
        'success',
      );
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
            const file = event.dataTransfer.files?.[0];
            if (file) upload(file);
          }}
          onClick={() => document.getElementById('import-file')?.click()}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition',
            dragging
              ? 'border-accent-500 bg-accent-500/10'
              : 'border-black/[0.10] bg-ink-800 hover:border-accent-500/50 hover:bg-accent-500/5',
          )}
        >
          <IconUpload className="h-6 w-6 text-ink-400" />
          <p className="text-sm text-ink-200">Trascina qui un file EPUB / PDF / DOCX / TXT</p>
          <p className="text-[11px] text-ink-500">oppure clicca per sceglierlo</p>
          <input
            id="import-file"
            type="file"
            accept=".epub,.pdf,.docx,.txt,.md,.rtf"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload(file);
              event.target.value = '';
            }}
          />
        </div>

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
