import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api, withLibrary } from '../api';
import {
  cn,
  formatDate,
  formatDuration,
  formatRating,
  formatWords,
  languageLabel,
  READING_STATUS_LABEL,
  relativeDate,
  saveBlob,
} from '../utils';
import BookCover from './BookCover';
import CoverEditor from './CoverEditor';
import FanficUpdateBox from './FanficUpdateBox';
import HighlightsTab from './HighlightsTab';
import LanguagesSection from './LanguagesSection';
import MoveBookMenu from './MoveBookMenu';
import AppleBooksDialog from './AppleBooksDialog';
import { desktop, unwrap } from '../desktop';
import {
  IconClose,
  IconCloud,
  IconDownload,
  IconImage,
  IconRefresh,
  IconSparkle,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconUpload,
  IconLink,
  IconFolder,
  IconLayers,
  IconShare,
  IconBook,
} from './icons';
import { FIELD_LABELS, READING_STATUSES } from '@shared/types';
import type { AppleBooksWriteStatus, BookMeta, MetadataCandidate } from '@shared/types';

/* ------------------------------------------------------------- campi base -- */

interface FieldRowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function FieldRow({ label, hint, children }: FieldRowProps) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-500">{hint}</span>}
    </label>
  );
}

function TextField({
  value,
  onCommit,
  placeholder,
  type = 'text',
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <input
      type={type}
      value={local}
      placeholder={placeholder}
      onChange={(event) => setLocal(event.target.value)}
      onBlur={() => local !== value && onCommit(local)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') setLocal(value);
      }}
      className="field-input"
    />
  );
}

function TextArea({
  value,
  onCommit,
  rows = 5,
}: {
  value: string;
  onCommit: (value: string) => void;
  rows?: number;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <textarea
      value={local}
      rows={rows}
      onChange={(event) => setLocal(event.target.value)}
      onBlur={() => local !== value && onCommit(local)}
      className="field-input resize-y leading-relaxed"
    />
  );
}

function ListField({
  value,
  onCommit,
  placeholder,
}: {
  value: string[];
  onCommit: (value: string[]) => void;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value.join(', '));
  useEffect(() => setLocal(value.join(', ')), [value]);
  return (
    <input
      value={local}
      placeholder={placeholder}
      onChange={(event) => setLocal(event.target.value)}
      onBlur={() => {
        const next = local
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        if (next.join('|') !== value.join('|')) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
      }}
      className="field-input"
    />
  );
}

function TagField({
  value,
  onCommit,
}: {
  value: string[];
  onCommit: (value: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const tag = draft.trim().replace(/^#/, '');
    if (!tag) return;
    if (!value.some((item) => item.toLowerCase() === tag.toLowerCase())) {
      onCommit([...value, tag]);
    }
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white px-2 py-2">
      {value.map((tag) => (
        <span key={tag} className="chip">
          {tag}
          <button
            onClick={() => onCommit(value.filter((item) => item !== tag))}
            className="ml-0.5 text-ink-500 hover:text-rose-600"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            add();
          }
          if (event.key === 'Backspace' && !draft && value.length) {
            onCommit(value.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder="Aggiungi tag…"
        className="min-w-[6rem] flex-1 bg-transparent text-sm outline-none placeholder:text-ink-500"
      />
    </div>
  );
}

/**
 * Voto a mezze stelle: ogni stella ha due zone cliccabili, la meta' sinistra
 * vale x,5 e la destra il voto intero. Cliccare il voto attuale lo azzera.
 */
function StarPicker({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
        {[1, 2, 3, 4, 5].map((star) => {
          const fill = shown >= star ? 1 : shown >= star - 0.5 ? 0.5 : 0;
          return (
            <span key={star} className="relative h-5 w-5">
              <IconStar
                className={cn('h-5 w-5 transition', fill ? 'text-amber-500' : 'text-ink-600')}
              />
              {fill > 0 && (
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden text-amber-500"
                  style={{ width: fill === 1 ? '100%' : '50%' }}
                >
                  <IconStarFilled className="h-5 w-5" />
                </span>
              )}
              {[star - 0.5, star].map((rating, half) => (
                <button
                  key={rating}
                  type="button"
                  aria-label={`Voto ${formatRating(rating)} su 5`}
                  title={formatRating(rating)}
                  onMouseEnter={() => setHover(rating)}
                  onFocus={() => setHover(rating)}
                  onBlur={() => setHover(null)}
                  onClick={() => onCommit(value === rating ? null : rating)}
                  className={cn('absolute inset-y-0 w-1/2', half ? 'right-0' : 'left-0')}
                />
              ))}
            </span>
          );
        })}
      </div>
      {value ? (
        <span className="ml-1 min-w-[1.5rem] text-[12px] font-semibold text-ink-300">
          {formatRating(value)}
        </span>
      ) : null}
      {value ? (
        <button onClick={() => onCommit(null)} className="ml-2 text-[11px] text-ink-500 hover:text-ink-300">
          azzera
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- pannello dettaglio -- */

export default function DetailPanel({
  onOpenSeries,
}: {
  onOpenSeries?: (series: string) => void;
}) {
  const { detail, select, patchDetail, detailTab, setDetailTab, busy, openReader, resetReading } = useStore();
  const { lookupAttempted, runLookup } = useStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [writing, setWriting] = useState(false);
  const [downloadMenu, setDownloadMenu] = useState(false);
  const [appleStatus, setAppleStatus] = useState<AppleBooksWriteStatus | null>(null);
  const [appleDialog, setAppleDialog] = useState(false);
  const downloadMenuRef = useRef<HTMLDivElement>(null);
  // «Leggi»: menu delle lingue del lettore integrato.
  const [readMenu, setReadMenu] = useState(false);
  const readMenuRef = useRef<HTMLDivElement>(null);
  // «Apri in Libri»: menu delle lingue, file in preparazione, file pronti e file da condividere al prossimo tocco.
  const [shareMenu, setShareMenu] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const [shareRetry, setShareRetry] = useState<{ key: string; file: string } | null>(null);
  const shareMenuRef = useRef<HTMLDivElement>(null);
  // App per Mac: file in preparazione per «Apri in Libri».
  const [openingBooks, setOpeningBooks] = useState<string | null>(null);
  const shareCache = useRef(new Map<string, { file: File; original: boolean }>());
  // Aprendo la scheda "Metadati online" la ricerca parte da sola.
  useEffect(() => {
    if (detailTab === 'online' && detail && !lookupAttempted) {
      void runLookup();
    }
  }, [detailTab, detail, lookupAttempted, runLookup]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Con il lettore aperto Esc spetta a lui.
      if (event.key === 'Escape' && document.activeElement?.tagName !== 'INPUT' && !useStore.getState().reader) {
        select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  // Scrittura su Apple Books: il pulsante compare solo se il server la trova possibile.
  const appleId = detail?.format === 'epub' ? detail.identifiers?.applebooks : undefined;
  const detailId = detail?.id;
  useEffect(() => {
    setAppleStatus(null);
    if (!detailId || !appleId) return;
    let cancelled = false;
    // Nell'app per Mac lo stato viene dal ponte (Apple Books e' sul Mac); nel browser dal server.
    const bridge = desktop();
    (bridge && detail
      ? bridge.appleBooksStatus(detail).then(unwrap)
      : api.appleBooksStatus(detailId)
    )
      .then((status) => {
        if (!cancelled) setAppleStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId, appleId]);

  // Menu delle lingue: si chiude con un clic fuori o con Esc (che non chiude il pannello).
  useEffect(() => {
    if (!downloadMenu && !shareMenu && !readMenu) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        downloadMenuRef.current?.contains(target) ||
        shareMenuRef.current?.contains(target) ||
        readMenuRef.current?.contains(target)
      ) {
        return;
      }
      setDownloadMenu(false);
      setShareMenu(false);
      setReadMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setDownloadMenu(false);
      setShareMenu(false);
      setReadMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [downloadMenu, shareMenu, readMenu]);

  if (!detail) return null;

  const meta = detail;
  const kind = meta.kind === 'fanfic' ? 'fanfic' : 'book';

  const commit = (patch: Partial<BookMeta>) => patchDetail(patch);

  const groups: Array<{ key: string; title: string; fields: string[] }> = [
    {
      key: 'core',
      title: 'Informazioni principali',
      fields: ['title', 'subtitle', 'authors', 'series', 'seriesIndex', 'description'],
    },
    {
      key: kind,
      title: kind === 'fanfic' ? 'Dettagli fanfiction' : 'Dettagli edizione',
      fields:
        kind === 'fanfic'
          ? ['fandom', 'ships', 'characters', 'relationships', 'fanRating', 'status', 'chapters', 'ao3Url', 'ffnetUrl']
          : ['publisher', 'publishedDate', 'language', 'isbn', 'pageCount'],
    },
    {
      key: 'extra',
      title: 'Personale',
      fields: ['tags', 'notes', 'readingStatus', 'readingProgress', 'dateStarted', 'dateFinished'],
    },
  ];

  // File scaricabili: prima il principale, poi gli extra (es. l'ODT delle storie EFP)
  // e, se il libro e' stato convertito, il file originale (es. MOBI).
  const files = [meta.sourceFile, ...(meta.extraFiles ?? []), meta.originalFile].filter(
    (file, index, all): file is string => Boolean(file) && all.indexOf(file) === index,
  );
  const fileLabel = (file: string) => {
    const label = file.split('.').pop()?.toUpperCase() || 'file';
    return file === meta.originalFile ? `${label} originale` : label;
  };

  // Lingue: la principale piu' le edizioni; i file delle edizioni non sono pulsanti a parte.
  const editions = meta.editions ?? [];
  const hasEditions = editions.length > 0;
  const editionFiles = new Set(editions.map((edition) => edition.file));
  const visibleFiles = files.filter((file) => !editionFiles.has(file));
  const languageRows = hasEditions
    ? [
        ...(meta.sourceFile
          ? [{ file: meta.sourceFile, language: meta.language, title: meta.title }]
          : []),
        ...editions,
      ]
    : [];
  const languageChips = [
    ...new Set([meta.language, ...editions.map((edition) => edition.language)].filter(Boolean)),
  ].map(languageLabel);

  // Lettore integrato: solo EPUB e PDF (l'originale MOBI e gli altri extra non si leggono).
  const readableRows = (hasEditions
    ? languageRows
    : meta.sourceFile
      ? [{ file: meta.sourceFile, language: meta.language, title: meta.title }]
      : []
  ).filter((row) => /\.(epub|pdf)$/i.test(row.file));

  const handleDownload = async (file: string) => {
    setDownloading(file);
    try {
      const { blob, filename } = await api.downloadBook(
        meta.id,
        file === meta.sourceFile ? undefined : file,
      );
      saveBlob(blob, filename);
    } catch (error) {
      useStore.getState().toast((error as Error).message, 'error');
    } finally {
      setDownloading(null);
    }
  };

  // Condivisione (Android e simili: foglio di sistema). Su desktop o senza file nella Web Share API non compare.
  const canShareEpub =
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches &&
    (() => {
      try {
        return navigator.canShare({ files: [new File([''], 'x.epub', { type: 'application/epub+zip' })] });
      } catch {
        return false;
      }
    })();
  const isApple =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  // Su iOS/iPadOS il foglio di condivisione non offre Libri: si naviga verso l'EPUB servito inline,
  // e Safari mostra l'anteprima con «Apri in "Libri"».
  const openInBooksUrl = (file: string) => {
    const params = new URLSearchParams({ meta: '1', inline: '1' });
    if (file !== meta.sourceFile) params.set('file', file);
    return withLibrary(`/api/books/${encodeURIComponent(meta.id)}/download?${params.toString()}`);
  };
  const shareFiles = (meta.format === 'epub' && meta.sourceFile ? [meta.sourceFile, ...editions.map((e) => e.file)] : [])
    .filter((file, index, all) => file.toLowerCase().endsWith('.epub') && all.indexOf(file) === index);

  // App per Mac: scarica l'EPUB con i metadati della scheda e lo passa a Libri.
  const handleOpenInBooksApp = async (file: string) => {
    const bridge = desktop();
    if (!bridge) return;
    setOpeningBooks(file);
    try {
      const { blob, filename, metadata } = await api.downloadBook(
        meta.id,
        file === meta.sourceFile ? undefined : file,
        { meta: true },
      );
      unwrap(await bridge.openInBooks({ data: await blob.arrayBuffer(), filename }));
      if (metadata === 'original') {
        useStore
          .getState()
          .toast("Aperto il file originale: non e' stato possibile scrivere i metadati della scheda", 'info');
      }
    } catch (error) {
      useStore.getState().toast((error as Error).message, 'error');
    } finally {
      setOpeningBooks(null);
    }
  };

  const handleShare = async (file: string) => {
    const key = `${meta.id}|${file}|${meta.dateModified}`;
    const title = editions.find((edition) => edition.file === file)?.title || meta.title;
    // share() deve partire da un gesto recente: se il file e' pronto si condivide subito.
    const share = async (item: File) => {
      try {
        await navigator.share({ files: [item], title });
        setShareRetry(null);
      } catch (error) {
        const name = (error as Error).name;
        if (name === 'AbortError') {
          setShareRetry(null);
        } else if (name === 'NotAllowedError') {
          // Attivazione scaduta durante il download: il file resta pronto per il tocco successivo.
          setShareRetry({ key, file });
        } else {
          setShareRetry(null);
          useStore.getState().toast((error as Error).message, 'error');
        }
      }
    };
    const cached = shareCache.current.get(key);
    if (cached) {
      await share(cached.file);
      return;
    }
    setSharing(key);
    let item: File;
    try {
      const { blob, filename, metadata } = await api.downloadBook(
        meta.id,
        file === meta.sourceFile ? undefined : file,
        { meta: true },
      );
      item = new File([blob], filename, { type: 'application/epub+zip' });
      shareCache.current.set(key, { file: item, original: metadata === 'original' });
      if (metadata === 'original') {
        useStore
          .getState()
          .toast("Inviato il file originale: non e' stato possibile scrivere i metadati della scheda", 'info');
      }
    } catch (error) {
      useStore.getState().toast((error as Error).message, 'error');
      return;
    } finally {
      setSharing(null);
    }
    await share(item);
  };

  const handleWriteEpub = async () => {
    if (!confirmWrite) {
      setConfirmWrite(true);
      setTimeout(() => setConfirmWrite(false), 4000);
      return;
    }
    setConfirmWrite(false);
    setWriting(true);
    try {
      await api.writeEpub(meta.id);
      useStore
        .getState()
        .toast(
          hasEditions
            ? `Copertina e metadati scritti nell'EPUB in ${languageLabel(meta.language)} (le altre lingue non sono state toccate; originale salvato in .backup)`
            : "Copertina e metadati scritti nell'EPUB (originale salvato in .backup)",
          'success',
        );
    } catch (error) {
      useStore.getState().toast((error as Error).message, 'error');
    } finally {
      setWriting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    try {
      await api.deleteBook(meta.id);
      select(null);
      useStore.getState().toast('Opera e file eliminati', 'success');
      await useStore.getState().load();
    } catch (error) {
      useStore.getState().toast((error as Error).message, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-ink-950/25 backdrop-blur-[2px] animate-fade-in"
        onClick={() => select(null)}
      />

      <aside className="relative flex h-[100dvh] w-full max-w-xl animate-slide-in flex-col border-l border-black/[0.07] bg-white shadow-panel">
        <header className="flex items-start gap-4 border-b border-black/[0.06] p-4">
          <BookCover
            id={meta.id}
            coverFile={meta.coverFile}
            title={meta.title}
            authors={meta.authors}
            kind={meta.kind}
            version={meta.dateModified}
            className="h-28 w-[4.5rem] shrink-0"
            rounded="rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 text-lg font-semibold leading-snug text-ink-50">
              {meta.title || 'Senza titolo'}
            </h2>
            <p className="mt-0.5 line-clamp-1 text-sm text-ink-300">
              {meta.authors.join(', ') || 'Autore sconosciuto'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="chip">{meta.format.toUpperCase()}</span>
              {meta.kind === 'fanfic' ? (
                <span className="chip border-rose-500/40 bg-rose-500/15 text-rose-600">fanfic</span>
              ) : (
                <span className="chip">libro</span>
              )}
              {hasEditions && languageChips.length > 0 && (
                <span className="chip">{languageChips.join(' · ')}</span>
              )}
              {meta.fandom && <span className="chip max-w-[12rem] truncate">{meta.fandom}</span>}
              {meta.wordCount && <span className="chip">{formatWords(meta.wordCount)}</span>}
              {meta.pageCount && <span className="chip">{meta.pageCount} pag.</span>}
              {meta.fanRating && <span className="chip font-semibold">{meta.fanRating}</span>}
            </div>
            <p className="mt-2 text-[11px] text-ink-500">
              Aggiunto il {formatDate(meta.dateAdded)} · modificato {relativeDate(meta.dateModified)}
            </p>
            {files.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {readableRows.length > 0 && (
                  <div ref={readMenuRef} className="relative">
                    <button
                      onClick={() => {
                        if (readableRows.length > 1) setReadMenu((open) => !open);
                        else openReader(meta.id, readableRows[0].file);
                      }}
                      className="btn-primary px-2.5 py-2 text-[12px] sm:py-1"
                      title="Leggi qui, nel lettore integrato"
                    >
                      <IconBook className="h-3.5 w-3.5" />
                      Leggi{readableRows.length > 1 ? ' ▾' : ''}
                    </button>
                    {readMenu && readableRows.length > 1 && (
                      <div className="absolute left-0 top-full z-10 mt-1 min-w-[16rem] max-w-[22rem] rounded-lg border border-black/[0.08] bg-white p-1 shadow-panel">
                        {readableRows.map((row) => (
                          <button
                            key={row.file}
                            onClick={() => {
                              setReadMenu(false);
                              openReader(meta.id, row.file);
                            }}
                            className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-200 hover:bg-black/[0.05]"
                            title={row.file}
                          >
                            {languageLabel(row.language)} · {row.title || row.file}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {visibleFiles.map((file, index) =>
                  hasEditions && file === meta.sourceFile ? (
                    <div key={file} ref={downloadMenuRef} className="relative">
                      <button
                        onClick={() => setDownloadMenu((open) => !open)}
                        disabled={downloading !== null}
                        className="btn-primary px-2.5 py-2 text-[12px] sm:py-1 disabled:opacity-60"
                        title="Scegli la lingua da scaricare"
                      >
                        <IconDownload
                          className={cn('h-3.5 w-3.5', downloading !== null && 'animate-pulse')}
                        />
                        Scarica {fileLabel(file)} ▾
                      </button>
                      {downloadMenu && (
                        <div className="absolute left-0 top-full z-10 mt-1 min-w-[16rem] max-w-[22rem] rounded-lg border border-black/[0.08] bg-white p-1 shadow-panel">
                          {languageRows.map((row) => (
                            <button
                              key={row.file}
                              onClick={() => {
                                setDownloadMenu(false);
                                void handleDownload(row.file);
                              }}
                              className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-200 hover:bg-black/[0.05]"
                              title={row.file}
                            >
                              {languageLabel(row.language)} · {row.title || row.file}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      key={file}
                      onClick={() => void handleDownload(file)}
                      disabled={downloading !== null}
                      className={cn(
                        index === 0 ? 'btn-primary' : 'btn-ghost',
                        'px-2.5 py-2 text-[12px] sm:py-1 disabled:opacity-60',
                      )}
                      title={`Scarica ${file}`}
                    >
                      <IconDownload
                        className={cn('h-3.5 w-3.5', downloading === file && 'animate-pulse')}
                      />
                      {index === 0 ? `Scarica ${fileLabel(file)}` : fileLabel(file)}
                    </button>
                  ),
                )}
                {desktop() && shareFiles.length > 0 && (
                  <div ref={shareMenuRef} className="relative">
                    <button
                      onClick={() => {
                        if (hasEditions && shareFiles.length > 1) setShareMenu((open) => !open);
                        else void handleOpenInBooksApp(meta.sourceFile as string);
                      }}
                      disabled={openingBooks !== null}
                      className="btn-primary px-2.5 py-2 text-[12px] sm:py-1 disabled:opacity-60"
                      title="Apre l'EPUB, con i metadati della scheda, nell'app Libri"
                    >
                      <IconShare className={cn('h-3.5 w-3.5', openingBooks !== null && 'animate-pulse')} />
                      {openingBooks !== null
                        ? 'Preparazione…'
                        : `Apri in Libri${hasEditions && shareFiles.length > 1 ? ' ▾' : ''}`}
                    </button>
                    {shareMenu && (
                      <div className="absolute left-0 top-full z-10 mt-1 min-w-[16rem] max-w-[22rem] rounded-lg border border-black/[0.08] bg-white p-1 shadow-panel">
                        {languageRows
                          .filter((row) => shareFiles.includes(row.file))
                          .map((row) => (
                            <button
                              key={row.file}
                              onClick={() => {
                                setShareMenu(false);
                                void handleOpenInBooksApp(row.file);
                              }}
                              className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-200 hover:bg-black/[0.05]"
                              title={row.file}
                            >
                              {languageLabel(row.language)} · {row.title || row.file}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )}
                {!desktop() && isApple && shareFiles.length > 0 && (
                  <div className="relative">
                    {hasEditions && shareFiles.length > 1 ? (
                      <div ref={shareMenuRef} className="relative">
                        <button
                          onClick={() => setShareMenu((open) => !open)}
                          className="btn-primary px-2.5 py-2 text-[12px] sm:py-1"
                          title={'Si apre l\'anteprima: tocca "Apri in Libri"'}
                        >
                          <IconShare className="h-3.5 w-3.5" />
                          Apri in Libri ▾
                        </button>
                        {shareMenu && (
                          <div className="absolute left-0 top-full z-10 mt-1 min-w-[16rem] max-w-[22rem] rounded-lg border border-black/[0.08] bg-white p-1 shadow-panel">
                            {languageRows
                              .filter((row) => shareFiles.includes(row.file))
                              .map((row) => (
                                <a
                                  key={row.file}
                                  href={openInBooksUrl(row.file)}
                                  target="_blank"
                                  rel="noopener"
                                  onClick={() => setShareMenu(false)}
                                  className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-200 hover:bg-black/[0.05]"
                                  title={row.file}
                                >
                                  {languageLabel(row.language)} · {row.title || row.file}
                                </a>
                              ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <a
                        href={openInBooksUrl(meta.sourceFile as string)}
                        target="_blank"
                        rel="noopener"
                        className="btn-primary px-2.5 py-2 text-[12px] sm:py-1"
                        title={'Si apre l\'anteprima: tocca "Apri in Libri"'}
                      >
                        <IconShare className="h-3.5 w-3.5" />
                        Apri in Libri
                      </a>
                    )}
                    <span className="mt-1 block text-[10px] leading-tight text-ink-400">
                      Si apre l'anteprima: tocca "Apri in Libri"
                    </span>
                  </div>
                )}
                {!desktop() && !isApple && canShareEpub && shareFiles.length > 0 && (
                  <div ref={shareMenuRef} className="relative">
                    {(() => {
                      const multi = hasEditions && shareFiles.length > 1;
                      // Il file e' gia' pronto ma il foglio non e' partito: serve un nuovo tocco.
                      const retry =
                        shareRetry !== null && shareRetry.key === `${meta.id}|${shareRetry.file}|${meta.dateModified}`
                          ? shareRetry
                          : null;
                      return (
                        <button
                          onClick={() => {
                            if (multi && !retry) setShareMenu((open) => !open);
                            else void handleShare(retry ? retry.file : (meta.sourceFile as string));
                          }}
                          disabled={sharing !== null}
                          className={cn(
                            'btn-primary px-2.5 py-2 text-[12px] sm:py-1 disabled:opacity-60',
                            retry && 'ring-2 ring-amber-400 ring-offset-1',
                          )}
                          title="Invia l'EPUB con i metadati della scheda (Condividi EPUB)"
                        >
                          <IconShare className={cn('h-3.5 w-3.5', sharing !== null && 'animate-pulse')} />
                          {sharing !== null
                            ? 'Preparazione…'
                            : retry
                              ? 'Tocca di nuovo per condividere'
                              : `Condividi EPUB${multi ? ' ▾' : ''}`}
                        </button>
                      );
                    })()}
                    {shareMenu && (
                      <div className="absolute left-0 top-full z-10 mt-1 min-w-[16rem] max-w-[22rem] rounded-lg border border-black/[0.08] bg-white p-1 shadow-panel">
                        {languageRows
                          .filter((row) => shareFiles.includes(row.file))
                          .map((row) => (
                            <button
                              key={row.file}
                              onClick={() => {
                                setShareMenu(false);
                                void handleShare(row.file);
                              }}
                              className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-200 hover:bg-black/[0.05]"
                              title={row.file}
                            >
                              {languageLabel(row.language)} · {row.title || row.file}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )}
                {meta.format === 'epub' && meta.sourceFile && (
                  <button
                    onClick={() => void handleWriteEpub()}
                    disabled={writing}
                    className="btn-ghost px-2.5 py-2 text-[12px] sm:py-1 disabled:opacity-60"
                    title={
                      hasEditions
                        ? `Sovrascrive copertina e metadati dentro il file EPUB della lingua principale (${languageLabel(meta.language)}) con quelli della scheda: le altre lingue non vengono toccate`
                        : 'Sovrascrive copertina e metadati dentro il file EPUB con quelli della scheda'
                    }
                  >
                    <IconUpload className={cn('h-3.5 w-3.5', writing && 'animate-pulse')} />
                    {confirmWrite ? 'Conferma: sovrascrivi EPUB' : "Scrivi nell'EPUB"}
                  </button>
                )}
                {appleStatus?.available && (
                  <button
                    onClick={() => setAppleDialog(true)}
                    className="btn-ghost px-2.5 py-2 text-[12px] sm:py-1"
                    title="Scrive copertina, titolo e autore nella copia del libro che Apple Books ha gia'"
                  >
                    <IconBook className="h-3.5 w-3.5" />
                    Scrivi su Apple Books
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-1.5">
            <button onClick={() => select(null)} className="btn-subtle h-10 w-10 px-0 sm:h-auto sm:w-auto sm:px-2" title="Chiudi">
              <IconClose />
            </button>
            <button
              onClick={async () => {
                try {
                  const updated = await api.refresh(meta.id);
                  useStore.setState({ detail: updated });
                  await useStore.getState().reloadBook(meta.id);
                  useStore.getState().toast('Metadati riletti dal file', 'success');
                } catch (error) {
                  useStore.getState().toast((error as Error).message, 'error');
                }
              }}
              className="btn-subtle h-10 w-10 px-0 sm:h-auto sm:w-auto sm:px-2"
              title="Rileggi i metadati dal file"
            >
              <IconRefresh className={busy ? 'animate-spin' : ''} />
            </button>
          </div>
        </header>

        <nav className="no-scrollbar flex gap-1 overflow-x-auto border-b border-black/[0.06] px-4 py-2">
          {(
            [
              ['details', 'Dettagli'],
              [
                'highlights',
                meta.highlights?.length
                  ? `Sottolineature (${meta.highlights.length})`
                  : 'Sottolineature',
              ],
              ['cover', 'Copertina'],
              ['online', 'Metadati online'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setDetailTab(key)}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-lg px-3 py-2.5 text-[13px] font-medium transition sm:py-1.5',
                detailTab === key
                  ? 'bg-accent-600 text-white'
                  : 'text-ink-300 hover:bg-black/[0.04] hover:text-ink-100',
              )}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-4">
          {detailTab === 'details' && (
            <div className="space-y-6">
              <FanficUpdateBox meta={meta} />
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-black/[0.06] bg-ink-800 p-3">
                <StarPicker
                  value={meta.rating}
                  onCommit={(rating) =>
                    // Dare un voto vuol dire averlo letto: "Da leggere" e "In
                    // lettura" passano a "Letto". DNF e Rilettura restano.
                    commit(
                      rating != null &&
                        (meta.readingStatus === 'unread' || meta.readingStatus === 'reading')
                        ? { rating, readingStatus: 'read' }
                        : { rating },
                    )
                  }
                />
                <button
                  onClick={() => commit({ favorite: !meta.favorite })}
                  className={cn(
                    'btn-ghost text-[13px]',
                    meta.favorite && 'border-rose-500/40 bg-rose-500/10 text-rose-600',
                  )}
                >
                  Preferito
                </button>
                <select
                  value={meta.readingStatus}
                  onChange={(event) =>
                    commit({ readingStatus: event.target.value as BookMeta['readingStatus'] })
                  }
                  className="field-input w-auto py-1.5 text-[13px]"
                >
                  {READING_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {READING_STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
                {(meta.readingStatus !== 'unread' ||
                  meta.readingProgress != null ||
                  meta.dateFinished ||
                  meta.dateStarted ||
                  Object.keys(meta.readingPositions ?? {}).length > 0) && (
                  <button
                    onClick={() => void resetReading()}
                    disabled={busy}
                    className="btn-ghost min-h-[2.5rem] text-[13px] sm:min-h-0"
                    title="Azzera stato, avanzamento, data di fine e posizione nel lettore"
                  >
                    Segna come non letto
                  </button>
                )}
                <button
                  onClick={() =>
                    commit({
                      kind: meta.kind === 'fanfic' ? 'book' : 'fanfic',
                    })
                  }
                  className="btn-ghost text-[13px]"
                  title="Cambia il tipo di opera"
                >
                  <IconSparkle className="h-4 w-4" />
                  {meta.kind === 'fanfic' ? 'Tratta da libro' : 'Tratta da fanfic'}
                </button>
              </div>

              {groups.map((group) => (
                <section key={group.key}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {group.title}
                  </h3>
                  <div className="space-y-3">
                    {group.fields.map((field) => {
                      const label = FIELD_LABELS[field] ?? field;
                      const value = (meta as unknown as Record<string, unknown>)[field];
                      switch (field) {
                        case 'title':
                        case 'subtitle':
                        case 'publisher':
                        case 'language':
                        case 'isbn':
                        case 'fandom':
                        case 'fanRating':
                        case 'status':
                        case 'ao3Url':
                        case 'ffnetUrl':
                        case 'efpUrl':
                          return (
                            <FieldRow key={field} label={label}>
                              <TextField
                                value={(value as string) ?? ''}
                                onCommit={(next) => commit({ [field]: next } as Partial<BookMeta>)}
                              />
                            </FieldRow>
                          );
                        case 'series':
                          return (
                            <FieldRow key={field} label={label}>
                              <div className="flex items-center gap-2">
                                <div className="min-w-0 flex-1">
                                  <TextField
                                    value={(value as string) ?? ''}
                                    onCommit={(next) => commit({ series: next })}
                                  />
                                </div>
                                {meta.series.trim() && onOpenSeries && (
                                  <button
                                    type="button"
                                    onClick={() => onOpenSeries(meta.series)}
                                    className="btn-ghost shrink-0 px-2.5 text-[11px]"
                                    title="Vedi i volumi della serie"
                                  >
                                    <IconLayers className="h-3.5 w-3.5" />
                                    Volumi
                                  </button>
                                )}
                              </div>
                            </FieldRow>
                          );
                        case 'publishedDate':
                          return (
                            <FieldRow key={field} label={label}>
                              <TextField
                                value={(value as string) ?? ''}
                                onCommit={(next) => commit({ publishedDate: next })}
                                placeholder="AAAA-MM-DD"
                              />
                            </FieldRow>
                          );
                        case 'dateStarted':
                        case 'dateFinished':
                          return (
                            <FieldRow key={field} label={label}>
                              <TextField
                                value={((value as string) ?? '').slice(0, 10)}
                                onCommit={(next) =>
                                  commit({ [field]: next || null } as Partial<BookMeta>)
                                }
                                type="date"
                              />
                            </FieldRow>
                          );
                        case 'description':
                        case 'notes':
                          return (
                            <FieldRow key={field} label={label}>
                              <TextArea
                                value={(value as string) ?? ''}
                                onCommit={(next) => commit({ [field]: next } as Partial<BookMeta>)}
                              />
                            </FieldRow>
                          );
                        case 'authors':
                        case 'ships':
                        case 'characters':
                        case 'relationships':
                          return (
                            <FieldRow key={field} label={label} hint="Separa con la virgola">
                              <ListField
                                value={(value as string[]) ?? []}
                                onCommit={(next) => commit({ [field]: next } as Partial<BookMeta>)}
                                placeholder="Nome autore…"
                              />
                            </FieldRow>
                          );
                        case 'tags':
                          return (
                            <FieldRow key={field} label={label} hint="Invio per aggiungere">
                              <TagField
                                value={(value as string[]) ?? []}
                                onCommit={(next) => commit({ tags: next })}
                              />
                            </FieldRow>
                          );
                        case 'seriesIndex':
                        case 'pageCount':
                        case 'chapters':
                        case 'wordCount':
                        case 'readingProgress':
                          return (
                            <FieldRow key={field} label={label}>
                              <TextField
                                value={value == null ? '' : String(value)}
                                type="number"
                                onCommit={(next) =>
                                  commit({
                                    [field]: next === '' ? null : Number(next),
                                  } as Partial<BookMeta>)
                                }
                              />
                            </FieldRow>
                          );
                        default:
                          return null;
                      }
                    })}
                  </div>
                </section>
              ))}

              <LanguagesSection meta={meta} />

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                  Informazioni tecniche
                </h3>
                <dl className="space-y-1.5 rounded-xl border border-black/[0.06] bg-ink-800 p-3 text-[12px]">
                  <Row label="Cartella">
                    <span className="inline-flex items-center gap-1 text-ink-300">
                      <IconFolder className="h-3.5 w-3.5" />
                      {meta.folder}
                    </span>
                  </Row>
                  <Row label="File sorgente">{meta.sourceFile ?? '—'}</Row>
                  <Row label="Lettura stimata">{formatDuration(meta.wordCount)}</Row>
                  <Row label="Parole">{formatWords(meta.wordCount)}</Row>
                  {meta.identifiers &&
                    Object.entries(meta.identifiers).map(([key, value]) => (
                      <Row key={key} label={key}>
                        <span className="truncate">{value}</span>
                      </Row>
                    ))}
                </dl>
              </section>

              <div className="flex flex-wrap justify-end gap-2 border-t border-black/[0.06] pt-4">
                <MoveBookMenu />
                <button
                  onClick={async () => {
                    try {
                      await api.deleteBook(meta.id, true);
                      select(null);
                      useStore.getState().toast('Opera rimossa dall\'indice (i file restano)', 'success');
                      await useStore.getState().load();
                    } catch (error) {
                      useStore.getState().toast((error as Error).message, 'error');
                    }
                  }}
                  className="btn-ghost"
                >
                  Rimuovi dall'indice
                </button>
                <button onClick={handleDelete} className="btn-danger">
                  <IconTrash className="h-4 w-4" />
                  {confirmDelete ? 'Conferma: elimina i file' : 'Elimina anche i file'}
                </button>
              </div>
            </div>
          )}

          {detailTab === 'highlights' && <HighlightsTab meta={meta} />}
          {detailTab === 'cover' && <CoverTab meta={meta} />}
          {detailTab === 'online' && <OnlineTab meta={meta} />}
        </div>
      </aside>
      {appleDialog && appleStatus?.available && (
        <AppleBooksDialog meta={meta} status={appleStatus} onClose={() => setAppleDialog(false)} />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-300">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------ copertina -- */

function CoverTab({ meta }: { meta: BookMeta }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { reloadBook } = useStore();

  const after = async (message: string) => {
    await reloadBook(meta.id);
    useStore.getState().toast(message, 'success');
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      await api.uploadCover(meta.id, file);
      await after('Copertina aggiornata');
    } catch (error) {
      useStore.getState().toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await api.coverFromUrl(meta.id, url.trim());
      setUrl('');
      await after('Copertina scaricata');
    } catch (error) {
      useStore.getState().toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-4 rounded-xl border border-black/[0.06] bg-ink-800 p-6">
        <BookCover
          id={meta.id}
          coverFile={meta.coverFile}
          title={meta.title}
          authors={meta.authors}
          kind={meta.kind}
          version={meta.dateModified}
          className="h-72 w-48"
          rounded="rounded-xl"
        />
        <p className="text-center text-[12px] text-ink-400">
          {meta.coverFile
            ? `Copertina attuale: ${meta.coverFile}`
            : 'Nessuna copertina presente. Estrarla dal file o caricane una.'}
        </p>
      </div>

      <div className="rounded-xl border border-accent-500/20 bg-accent-500/[.06] p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/15 text-accent-600 ring-1 ring-inset ring-accent-400/20">
            <IconSparkle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-100">Copertina in stile Penguin</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-400">
              Crea una copertina Penguin Classics per{' '}
              {meta.kind === 'fanfic' ? 'questa fanfiction' : 'questa opera'}, con anteprima dal
              vivo e salvataggio diretto nella scheda.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditorOpen(true)}
          className="btn-primary mt-3 w-full"
        >
          <IconSparkle className="h-4 w-4" />
          Crea copertina Penguin
        </button>
      </div>

      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files?.[0];
          if (file) upload(file);
        }}
        onClick={() => fileRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-black/[0.10] bg-ink-800 px-4 py-8 text-center transition hover:border-accent-500/50 hover:bg-accent-500/5"
      >
        <IconUpload className="h-6 w-6 text-ink-400" />
        <p className="text-sm text-ink-200">Trascina qui la copertina</p>
        <p className="text-[11px] text-ink-500">oppure clicca per scegliere un file (jpg, png, webp)</p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload(file);
            event.target.value = '';
          }}
        />
      </div>

      <div className="rounded-xl border border-black/[0.06] bg-ink-800 p-4">
        <p className="field-label">Scarica da URL</p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <IconLink className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…/copertina.jpg"
              className="field-input pl-9"
            />
          </div>
          <button onClick={download} disabled={busy || !url.trim()} className="btn-ghost">
            <IconCloud className="h-4 w-4" />
            Scarica
          </button>
        </div>
        <p className="mt-2 text-[11px] text-ink-500">
          Usato anche per importare le copertine trovate nelle ricerche online.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={async () => {
            setBusy(true);
            try {
              const updated = await api.extractCover(meta.id);
              useStore.setState({ detail: updated });
              await reloadBook(meta.id);
              useStore.getState().toast('Copertina estratta dal file', 'success');
            } catch (error) {
              useStore.getState().toast((error as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
          className="btn-ghost"
        >
          <IconRefresh className="h-4 w-4" />
          Estrai copertina dal file
        </button>
        {meta.coverFile && (
          <button
            onClick={async () => {
              await api.removeCover(meta.id);
              await after('Copertina rimossa');
            }}
            className="btn-danger"
          >
            <IconTrash className="h-4 w-4" />
            Rimuovi copertina
          </button>
        )}
      </div>

      {editorOpen && <CoverEditor meta={meta} onClose={() => setEditorOpen(false)} />}
    </div>
  );
}

/* -------------------------------------------------------- metadati online -- */

function diffKeys(current: BookMeta, candidate: MetadataCandidate): string[] {
  const keys = Object.keys(candidate.fields).filter((key) => {
    const incoming = (candidate.fields as Record<string, unknown>)[key];
    const existing = (current as unknown as Record<string, unknown>)[key];
    if (incoming === undefined || incoming === null || incoming === '') return false;
    if (Array.isArray(incoming)) return incoming.join('|') !== (existing as string[] | undefined)?.join('|');
    return String(incoming) !== String(existing ?? '');
  });
  return keys;
}

const PROVIDER_LABELS: Record<string, string> = {
  googlebooks: 'Google Books',
  openlibrary: 'Open Library',
  goodreads: 'Goodreads (serie)',
};

function OnlineTab({ meta }: { meta: BookMeta }) {
  const {
    lookup,
    lookupLoading,
    runLookup,
    importGoogleVolume,
    importAo3,
    applyCandidate,
    busy,
    settings,
    setSettingsOpen,
  } = useStore();
  const [googleUrl, setGoogleUrl] = useState('');
  const [ao3Url, setAo3Url] = useState('');

  const candidates = useMemo(() => lookup?.candidates ?? [], [lookup]);
  const fanficUrl = meta.ao3Url || ao3Url.trim();

  const sources = (settings?.providers ?? ['googlebooks', 'openlibrary'])
    .filter((provider) => provider !== 'goodreads')
    .map((provider) => PROVIDER_LABELS[provider] ?? provider)
    .concat(fanficUrl ? 'pagina della fanfic' : []);

  const googleQuotaError = lookup?.errors?.some(
    (error) => /google books/i.test(error) && /(429|403|quota|limite)/i.test(error),
  );
  const googleServiceError = lookup?.errors?.some(
    (error) => /google books/i.test(error) && /(503|temporaneamente non disponibile)/i.test(error),
  );
  const fanficSiteError = lookup?.errors?.some(
    (error) => /(AO3|Archive of Our Own|fanfic|FanFiction\.net)/i.test(error),
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-black/[0.06] bg-ink-800 p-4">
        <p className="text-sm text-ink-200">
          Cerca i metadati online per <span className="font-semibold">{meta.title}</span>
          {meta.authors[0] && <span className="text-ink-400"> di {meta.authors[0]}</span>}.
        </p>
        <p className="mt-1 text-[12px] text-ink-500">
          Le fonti disponibili: {sources.join(', ')}. Nessun dato viene applicato senza conferma.
        </p>
        <button onClick={runLookup} disabled={lookupLoading} className="btn-primary mt-3">
          <IconSparkle className={cn('h-4 w-4', lookupLoading && 'animate-spin')} />
          {lookupLoading ? 'Ricerca in corso…' : 'Cerca online'}
        </button>

        <div className="mt-4 border-t border-black/[0.06] pt-3">
          <span className="field-label">Link Google Books (opzionale)</span>
          <div className="flex gap-2">
            <input
              value={googleUrl}
              onChange={(event) => setGoogleUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && googleUrl.trim() && !busy) {
                  void importGoogleVolume(googleUrl).then((ok) => {
                    if (ok) setGoogleUrl('');
                  });
                }
              }}
              placeholder="https://books.google.com/books/edition/…/ID"
              className="field-input"
            />
            <button
              onClick={async () => {
                const ok = await importGoogleVolume(googleUrl);
                if (ok) setGoogleUrl('');
              }}
              disabled={busy || !googleUrl.trim()}
              className="btn-ghost shrink-0"
              title="Carica questa specifica edizione"
            >
              <IconLink className="h-4 w-4" />
              Importa
            </button>
          </div>
          <span className="mt-1 block text-[11px] text-ink-500">
            Incolla il link (o l'ID) di una specifica edizione Google Books: utile se la ricerca
            non trova l'edizione giusta o manca la descrizione.
          </span>
        </div>

        {meta.kind === 'fanfic' && (
          <div className="mt-4 border-t border-black/[0.06] pt-3">
            <span className="field-label">Link AO3 (opzionale)</span>
            <div className="flex gap-2">
              <input
                value={ao3Url}
                onChange={(event) => setAo3Url(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && ao3Url.trim() && !busy) {
                    void importAo3(ao3Url).then((ok) => {
                      if (ok) setAo3Url('');
                    });
                  }
                }}
                placeholder="https://archiveofourown.org/works/123456"
                className="field-input"
              />
              <button
                onClick={async () => {
                  const ok = await importAo3(ao3Url);
                  if (ok) setAo3Url('');
                }}
                disabled={busy || !ao3Url.trim()}
                className="btn-ghost shrink-0"
                title="Carica i metadati da AO3"
              >
                <IconLink className="h-4 w-4" />
                Importa
              </button>
            </div>
            <span className="mt-1 block text-[11px] text-ink-500">
              Incolla il link dell'opera su AO3 (o solo l'ID). Se il link manca, i metadati
              vengono letti dalla pagina informativa dell'EPUB.
            </span>
          </div>
        )}
      </div>

      {lookup?.missing?.length ? (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="field-label !text-amber-700">Campi ancora vuoti</p>
          <div className="flex flex-wrap gap-1.5">
            {lookup.missing.map((field) => (
              <span key={field} className="chip border-amber-500/30 text-amber-700">
                {FIELD_LABELS[field] ?? field}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {lookup?.errors?.length ? (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-[12px] text-rose-600">
          {lookup.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
          {googleQuotaError && (
            <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-rose-500/20 pt-3">
              <p className="min-w-[12rem] flex-1 text-[11px] leading-relaxed text-rose-600/80">
                Puoi aggiungere una chiave API gratuita per alzare il limite, oppure
                disattivare Google Books e usare solo Open Library.
              </p>
              <button
                onClick={() => setSettingsOpen(true)}
                className="btn-ghost border-rose-500/30 text-[12px] text-rose-600 hover:bg-rose-500/10"
              >
                Apri impostazioni
              </button>
            </div>
          )}
          {googleServiceError && (
            <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-rose-500/20 pt-3">
              <p className="min-w-[12rem] flex-1 text-[11px] leading-relaxed text-rose-600/80">
                La ricerca di Google Books è momentaneamente KO, ma il caricamento diretto
                di una singola edizione funziona: incolla il link nel campo «Link Google
                Books» qui sopra.
              </p>
            </div>
          )}
          {fanficSiteError && (
            <div className="mt-3 border-t border-rose-500/20 pt-3">
              <p className="text-[11px] leading-relaxed text-rose-600/80">
                Se AO3 non risponde, i metadati della fanfic restano quelli letti dall'EPUB.
                Puoi rileggerli dalla pagina informativa del file con il pulsante ↻ in alto
                a destra, oppure incollare il link AO3 qui sopra.
              </p>
            </div>
          )}
        </div>
      ) : null}

      {candidates.length === 0 && !lookupLoading ? (
        <div className="rounded-xl border border-black/[0.06] bg-ink-800 p-6 text-center">
          <IconImage className="mx-auto mb-2 h-6 w-6 text-ink-600" />
          {lookup ? (
            <>
              <p className="text-sm text-ink-300">Nessun risultato online per questa ricerca.</p>
              <p className="mt-1 text-[12px] text-ink-500">
                Verifica titolo e autore, oppure compila i campi a mano nella scheda «Dettagli».
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-300">Ricerca non ancora eseguita.</p>
              <p className="mt-1 text-[12px] text-ink-500">
                Avviala con il pulsante qui sopra: i risultati non vengono applicati senza
                conferma.
              </p>
            </>
          )}
        </div>
      ) : null}

      {candidates.map((candidate, index) => {
        const changed = diffKeys(meta, candidate);
        return (
          <div key={`${candidate.provider}-${index}`} className="rounded-xl border border-black/[0.06] bg-ink-800 p-4">
            <div className="flex items-start gap-3">
              {candidate.coverUrl ? (
                <img
                  src={candidate.coverUrl}
                  alt=""
                  className="h-20 w-14 shrink-0 rounded object-cover ring-1 ring-black/[0.08]"
                  onError={(event) => {
                    event.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded bg-ink-800 text-ink-600">
                  <IconImage className="h-5 w-5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="chip border-accent-500/40 bg-accent-500/10 text-accent-700">
                    {candidate.label}
                  </span>
                  {changed.length > 0 && (
                    <span className="text-[11px] text-ink-500">{changed.length} campi nuovi</span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-sm font-medium text-ink-100">
                  {candidate.fields.title || '(senza titolo)'}
                </p>
                <p className="line-clamp-1 text-[12px] text-ink-400">
                  {(candidate.fields.authors ?? []).join(', ')}
                </p>
                {candidate.summary && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-ink-500">{candidate.summary}</p>
                )}
              </div>
            </div>

            {changed.length > 0 && (
              <dl className="mt-3 space-y-1 border-t border-black/[0.06] pt-3 text-[12px]">
                {changed.slice(0, 8).map((key) => {
                  const value = (candidate.fields as Record<string, unknown>)[key];
                  const text = Array.isArray(value) ? value.join(', ') : String(value);
                  return (
                    <div key={key} className="flex gap-2">
                      <dt className="w-36 shrink-0 text-ink-500">
                        {FIELD_LABELS[key] ?? key}
                      </dt>
                      <dd className="min-w-0 flex-1 truncate text-ink-200">{text}</dd>
                    </div>
                  );
                })}
                {changed.length > 8 && (
                  <p className="text-[11px] text-ink-500">e altri {changed.length - 8} campi…</p>
                )}
              </dl>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => applyCandidate(candidate)}
                disabled={busy}
                className="btn-primary text-[13px]"
              >
                Applica
              </button>
              {candidate.url && (
                <a
                  href={candidate.url}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost text-[13px]"
                >
                  Apri la pagina
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
