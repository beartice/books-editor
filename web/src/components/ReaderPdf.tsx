import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { usePositionSaver } from './readerSave';
import {
  BAR_HEIGHT,
  ChevronLeft,
  ChevronRight,
  CloseIcon,
  READER_THEMES,
  ReaderButton,
  ReaderMessage,
  barStyle,
  readStoredTheme,
} from './ReaderParts';
import type { BookMeta } from '@shared/types';

// Il worker arriva dallo stesso dominio (la CSP non ammette script esterni).
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
/** Larghezza massima (px CSS) della pagina a zoom 1: su schermi larghi non si allarga all'infinito. */
const MAX_PAGE_WIDTH = 1100;
/** Safari limita l'area di un canvas (circa 16 milioni di pixel): oltre, si riduce la risoluzione. */
const MAX_CANVAS_PIXELS = 14_000_000;
const SWIPE_DISTANCE = 50;

interface Props {
  meta: BookMeta;
  file: string;
  data: ArrayBuffer;
  onClose: () => void;
}

/** Lettore PDF (pdf.js): una pagina alla volta su canvas, adattata alla larghezza. */
export default function ReaderPdf({ meta, file, data, onClose }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const saver = usePositionSaver(meta.id, file);
  const theme = READER_THEMES[readStoredTheme()];

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [bars, setBars] = useState(true);
  const [jump, setJump] = useState('1');
  const total = doc?.numPages ?? 0;

  const live = useRef({ page, total, zoom, onClose });
  live.current = { page, total, zoom, onClose };

  // Apertura del documento.
  useEffect(() => {
    let cancelled = false;
    // pdf.js prende in carico il buffer: ne riceve una copia, cosi' il componente puo' rimontarsi.
    const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false });
    task.promise
      .then((loaded) => {
        if (cancelled) return;
        const saved = Number.parseInt(meta.readingPositions?.[file]?.location ?? '', 10);
        const start = Number.isFinite(saved) ? Math.min(Math.max(1, saved), loaded.numPages) : 1;
        setDoc(loaded);
        setPage(start);
        setJump(String(start));
      })
      .catch((failure: Error) => {
        if (cancelled) return;
        setError(
          failure?.name === 'PasswordException'
            ? 'Il PDF e\' protetto da password.'
            : 'Il file PDF e\' danneggiato o non valido.',
        );
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, meta.id, file]);

  // Larghezza disponibile: la pagina si adatta e si riadatta ruotando il telefono.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const update = () => setWidth(wrap.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [doc]);

  // Disegno della pagina su un canvas nuovo, sostituito a quello vecchio a disegno finito.
  useEffect(() => {
    if (!doc || !width) return undefined;
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const fit = Math.min(width - 16, MAX_PAGE_WIDTH) / base.width;
      const cssViewport = pdfPage.getViewport({ scale: fit * zoom });
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_CANVAS_PIXELS / (cssViewport.width * cssViewport.height)),
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(cssViewport.width * ratio);
      canvas.height = Math.floor(cssViewport.height * ratio);
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      canvas.style.background = '#ffffff';
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas non disponibile');
      task = pdfPage.render({ canvasContext: context, viewport: pdfPage.getViewport({ scale: fit * zoom * ratio }) });
      await task.promise;
      if (cancelled) return;
      holderRef.current?.replaceChildren(canvas);
    })().catch((failure: Error) => {
      if (cancelled || failure?.name === 'RenderingCancelledException') return;
      setError('Impossibile mostrare questa pagina del PDF.');
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, width]);

  const goTo = useCallback(
    (target: number) => {
      const { total: count, page: current } = live.current;
      if (!count) return;
      const next = Math.min(Math.max(1, Math.round(target)), count);
      setJump(String(next));
      if (next === current) return;
      setPage(next);
      wrapRef.current?.scrollTo({ top: 0, left: 0 });
      saver.update(String(next), (next / count) * 100);
    },
    [saver],
  );

  const changeZoom = (delta: number) =>
    setZoom((value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((value + delta) * 100) / 100)));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT' && event.key !== 'Escape') return;
      const { page: current, onClose: close } = live.current;
      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
          goTo(current + 1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          goTo(current - 1);
          break;
        case ' ':
          goTo(event.shiftKey ? current - 1 : current + 1);
          break;
        case '+':
        case '=':
          changeZoom(ZOOM_STEP);
          break;
        case '-':
          changeZoom(-ZOOM_STEP);
          break;
        case 'Escape':
          close();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo]);

  // Swipe e tocco: a zoom 1 la pagina intera si gira; ingrandita, lo scorrimento resta alla pagina.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const swipedAt = useRef(0);
  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.changedTouches[0];
    touchStart.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const touch = event.changedTouches[0];
    const start = touchStart.current;
    touchStart.current = null;
    if (!touch || !start || live.current.zoom > 1.05) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swipedAt.current = Date.now();
      goTo(live.current.page + (dx < 0 ? 1 : -1));
    }
  };
  const onClick = (event: React.MouseEvent) => {
    if (Date.now() - swipedAt.current < 500) return;
    if (live.current.zoom > 1.05) {
      setBars((visible) => !visible);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / Math.max(1, box.width);
    if (ratio < 1 / 3) goTo(live.current.page - 1);
    else if (ratio > 2 / 3) goTo(live.current.page + 1);
    else setBars((visible) => !visible);
  };

  const submitJump = (event: FormEvent) => {
    event.preventDefault();
    // Il campo perde il focus: cosi' le frecce tornano a girare pagina.
    (document.activeElement as HTMLElement | null)?.blur();
    const target = Number.parseInt(jump, 10);
    if (Number.isFinite(target)) goTo(target);
    else setJump(String(page));
  };

  if (error) {
    return <ReaderMessage theme={theme} title="Impossibile aprire il libro" detail={error} error onClose={onClose} />;
  }

  const safeTop = 'env(safe-area-inset-top)';
  const safeBottom = 'env(safe-area-inset-bottom)';

  return (
    <div className="absolute inset-0 select-none" style={{ background: theme.background, color: theme.text }}>
      <div
        ref={wrapRef}
        className="absolute inset-x-0 overflow-auto overscroll-contain"
        style={{ top: `calc(${BAR_HEIGHT}px + ${safeTop})`, bottom: `calc(${BAR_HEIGHT}px + ${safeBottom})` }}
        onClick={onClick}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Margine uguale ai lati: a zoom 1 la pagina e' centrata, ingrandita scorre. */}
        <div ref={holderRef} className="mx-auto w-max px-2 py-2" />
      </div>

      {!doc && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px]"
          style={{ color: theme.muted }}
        >
          Apro il PDF…
        </div>
      )}

      <div
        className="pointer-events-none absolute inset-x-0 truncate px-4 text-center text-[11px]"
        style={{ bottom: `calc(${safeBottom} + 14px)`, color: theme.muted, opacity: bars ? 0 : 1 }}
      >
        {total ? `Pagina ${page} di ${total} · ${Math.round((page / total) * 100)}%` : ''}
      </div>

      <div
        className="absolute inset-x-0 z-10 flex items-center gap-1 border-b px-2"
        style={{ ...barStyle(theme, 'top', bars), height: `calc(${BAR_HEIGHT}px + ${safeTop})` }}
      >
        <ReaderButton onClick={onClose} aria-label="Chiudi il lettore" title="Chiudi (Esc)">
          <CloseIcon />
        </ReaderButton>
        <p className="min-w-0 flex-1 truncate px-1 text-center text-[13px] font-medium">{meta.title}</p>
        <ReaderButton
          onClick={() => changeZoom(-ZOOM_STEP)}
          disabled={zoom <= ZOOM_MIN}
          aria-label="Riduci lo zoom"
          title="Riduci lo zoom"
        >
          −
        </ReaderButton>
        <span className="w-11 text-center text-[12px] tabular-nums">{Math.round(zoom * 100)}%</span>
        <ReaderButton
          onClick={() => changeZoom(ZOOM_STEP)}
          disabled={zoom >= ZOOM_MAX}
          aria-label="Ingrandisci"
          title="Ingrandisci"
        >
          +
        </ReaderButton>
      </div>

      <div
        className="absolute inset-x-0 z-10 flex items-center justify-between gap-2 border-t px-2"
        style={{ ...barStyle(theme, 'bottom', bars), height: `calc(${BAR_HEIGHT}px + ${safeBottom})` }}
      >
        <ReaderButton
          onClick={() => goTo(page - 1)}
          disabled={page <= 1}
          aria-label="Pagina precedente"
          title="Pagina precedente"
        >
          <ChevronLeft />
        </ReaderButton>
        <form onSubmit={submitJump} className="flex items-center justify-center gap-1.5 text-[13px]">
          <span>Pagina</span>
          <input
            value={jump}
            onChange={(event) => setJump(event.target.value.replace(/\D/g, ''))}
            onFocus={(event) => event.target.select()}
            inputMode="numeric"
            aria-label="Vai alla pagina"
            className="h-10 w-14 rounded-lg border bg-transparent text-center tabular-nums"
            style={{ borderColor: theme.border }}
          />
          <span>di {total || '…'}</span>
        </form>
        <ReaderButton
          onClick={() => goTo(page + 1)}
          disabled={!total || page >= total}
          aria-label="Pagina successiva"
          title="Pagina successiva"
        >
          <ChevronRight />
        </ReaderButton>
      </div>
    </div>
  );
}
