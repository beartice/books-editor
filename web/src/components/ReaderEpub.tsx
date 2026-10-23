import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ePub, { EpubCFI } from 'epubjs';
import type { Book, Contents, Location, NavItem, Rendition } from 'epubjs';
import { api } from '../api';
import { useStore } from '../store';
import { cn } from '../utils';
import { HighlightMenu, HighlightsPanel, markStyle } from './ReaderHighlights';
import type { HighlightMenuState, MenuRect } from './ReaderHighlights';
import { usePositionSaver } from './readerSave';
import {
  BAR_HEIGHT,
  ChevronLeft,
  ChevronRight,
  CloseIcon,
  FONT_SIZES,
  READER_THEMES,
  ReaderButton,
  ReaderMessage,
  barStyle,
  readStoredFontSize,
  readStoredTheme,
  storeFontSize,
  storeTheme,
} from './ReaderParts';
import type { ReaderTheme, ReaderThemeName } from './ReaderParts';
import type { BookHighlight, BookMeta, HighlightColor } from '@shared/types';

/** Caratteri per ogni «posizione» usata per calcolare la percentuale. */
const LOCATION_CHARS = 1600;
const LOCATIONS_PREFIX = 'books.reader.locations.';
/** Dopo quanto un EPUB che non si apre viene dichiarato illeggibile. */
const OPEN_TIMEOUT_MS = 25000;
/** Spostamento minimo (px) di uno swipe orizzontale. */
const SWIPE_DISTANCE = 50;

interface TocEntry {
  label: string;
  href: string;
  depth: number;
  /** Posizione del capitolo nella spina del libro, -1 se non trovata. */
  spineIndex: number;
}

/** Appiattisce l'indice annidato, trovando per ogni voce il file del libro a cui punta. */
function flattenToc(book: Book, items: NavItem[], depth = 0): TocEntry[] {
  const result: TocEntry[] = [];
  for (const item of items) {
    let spineIndex = -1;
    try {
      const section = book.spine.get(item.href.split('#')[0]);
      spineIndex = typeof section?.index === 'number' ? section.index : -1;
    } catch {
      /* voce che punta a un file inesistente: resta senza capitolo */
    }
    result.push({ label: item.label.trim() || '(senza titolo)', href: item.href, depth, spineIndex });
    if (item.subitems?.length) result.push(...flattenToc(book, item.subitems, depth + 1));
  }
  return result;
}

/** Regole CSS del tema dentro l'EPUB; i temi scuri sovrascrivono anche i colori scelti dal libro. */
function themeRules(name: ReaderThemeName, theme: ReaderTheme) {
  const rules: Record<string, Record<string, string>> = {
    'html, body': { background: `${theme.background} !important`, color: `${theme.text} !important` },
    img: { 'max-width': '100% !important', 'max-height': '95vh !important', 'object-fit': 'contain' },
  };
  if (name !== 'light') {
    rules['body *'] = { color: 'inherit !important', 'background-color': 'transparent !important' };
    rules['body a'] = { color: `${name === 'dark' ? '#8fc4ae' : '#235347'} !important` };
  }
  return rules;
}

function locationsKey(meta: BookMeta, file: string): string {
  return `${LOCATIONS_PREFIX}${meta.id}|${file}|${meta.dateModified}`;
}

/** Percentuali gia' calcolate per questo file; se il localStorage non c'e' o e' pieno, si ricalcolano. */
function loadCachedLocations(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeLocations(key: string, value: string): void {
  const prefix = key.slice(0, key.lastIndexOf('|') + 1);
  const dropOld = (all: boolean) => {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const name = window.localStorage.key(index);
      if (name?.startsWith(LOCATIONS_PREFIX) && name !== key && (all || name.startsWith(prefix))) {
        window.localStorage.removeItem(name);
      }
    }
  };
  try {
    dropOld(false);
    window.localStorage.setItem(key, value);
  } catch {
    try {
      // Pieno: si liberano le percentuali degli altri libri e si riprova una volta.
      dropOld(true);
      window.localStorage.setItem(key, value);
    } catch {
      /* niente cache: la prossima apertura le ricalcola */
    }
  }
}

/** Vista di epub.js che disegna i segni nel testo (l'API pubblica passa da `annotations`, che non tollera CFI non validi). */
interface MarkView {
  index: number;
  contents?: Contents;
  highlights: Record<string, unknown>;
  underlines: Record<string, unknown>;
  highlight: (cfi: string, data: object, cb: undefined, className: string, styles: object) => void;
  underline: (cfi: string, data: object, cb: undefined, className: string, styles: object) => void;
  unhighlight: (cfi: string) => void;
  ununderline: (cfi: string) => void;
}

/** Posizione del capitolo nella spina per un CFI, -1 se il CFI non si legge. */
function spinePosOf(cfi: string): number {
  try {
    const pos = new EpubCFI(cfi).spinePos;
    return typeof pos === 'number' ? pos : -1;
  } catch {
    return -1;
  }
}

/** Rettangolo di un intervallo, dalle coordinate dell'iframe a quelle della finestra. */
function rectOf(range: Range, contents: Contents): MenuRect | null {
  const rects = Array.from(range.getClientRects());
  if (!rects.length) return null;
  const frame = contents.window.frameElement as HTMLElement | null;
  const offset = frame?.getBoundingClientRect();
  const dx = offset?.left ?? 0;
  const dy = offset?.top ?? 0;
  return {
    top: Math.min(...rects.map((rect) => rect.top)) + dy,
    bottom: Math.max(...rects.map((rect) => rect.bottom)) + dy,
    left: Math.min(...rects.map((rect) => rect.left)) + dx,
    right: Math.max(...rects.map((rect) => rect.right)) + dx,
  };
}

interface Props {
  meta: BookMeta;
  file: string;
  data: ArrayBuffer;
  /** Posizione (CFI) da cui aprire, al posto dell'ultima salvata. */
  startLocation?: string;
  onClose: () => void;
}

/** Lettore EPUB (epub.js): pagine, indice, dimensione del testo e temi. */
export default function ReaderEpub({ meta, file, data, startLocation, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const cfiRef = useRef<string | null>(null);
  const saver = usePositionSaver(meta.id, file);

  const [themeName, setThemeName] = useState<ReaderThemeName>(readStoredTheme);
  const [fontSize, setFontSize] = useState(readStoredFontSize);
  const [bars, setBars] = useState(true);
  const [panel, setPanel] = useState<'toc' | 'settings' | 'highlights' | null>(null);
  const [highlights, setHighlights] = useState<BookHighlight[]>(meta.highlights ?? []);
  const [menu, setMenu] = useState<HighlightMenuState | null>(null);
  // Nota in scrittura per una nuova sottolineatura (null = campo chiuso).
  const [draft, setDraft] = useState<string | null>(null);
  const [menuError, setMenuError] = useState('');
  const sheet = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [spineIndex, setSpineIndex] = useState(-1);
  const [percent, setPercent] = useState<number | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState('');
  const theme = READER_THEMES[themeName];

  // Valori letti dai gestori degli eventi dell'EPUB, che vivono piu' a lungo di un render.
  // Sottolineature di questo file: quelle senza `file` valgono per il principale.
  const fileHighlights = useMemo(
    () => highlights.filter((item) => (item.file ?? meta.sourceFile) === file),
    [highlights, file, meta.sourceFile],
  );
  const live = useRef({ panel, bars, onClose, saver, themeName, fontSize, fileHighlights, menu, draft, toc: [] as TocEntry[] });
  live.current = { panel, bars, onClose, saver, themeName, fontSize, fileHighlights, menu, draft, toc };
  const paintAll = useRef<() => void>(() => undefined);
  const closeMenu = useCallback(() => {
    setMenu(null);
    setDraft(null);
    setMenuError('');
  }, []);

  const go = useCallback((direction: 'next' | 'prev') => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    void (direction === 'next' ? rendition.next() : rendition.prev());
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let book: Book;
    try {
      book = ePub(data);
    } catch {
      setError('Il file EPUB e\' danneggiato o non valido.');
      return undefined;
    }
    book.opened.catch(() => {
      if (!cancelled) setError('Il file EPUB e\' danneggiato o non valido.');
    });

    // Gli script dell'EPUB non devono mai girare: l'iframe resta senza `allow-scripts`.
    const rendition = book.renderTo(container, {
      width: '100%',
      height: '100%',
      flow: 'paginated',
      spread: 'auto',
      minSpreadWidth: 1000,
      allowScriptedContent: false,
    });
    renditionRef.current = rendition;

    for (const [name, value] of Object.entries(READER_THEMES) as [ReaderThemeName, ReaderTheme][]) {
      rendition.themes.register(name, themeRules(name, value));
    }
    rendition.themes.select(live.current.themeName);
    rendition.themes.fontSize(`${live.current.fontSize}%`);

    const locationKey = locationsKey(meta, file);
    let locationsReady = false;
    let moved = false;
    let firstRelocation = true;

    const spineLength = () => Math.max(1, (book.spine as unknown as { length?: number }).length ?? 1);
    // Prima che le percentuali siano pronte si usa una stima dalla posizione nel libro.
    const progressOf = (location: Location): number => {
      if (location.atEnd) return 100;
      if (locationsReady) {
        return Math.min(100, Math.max(0, book.locations.percentageFromCfi(location.start.cfi) * 100));
      }
      const { page, total } = location.start.displayed;
      return Math.min(100, ((location.start.index + (page - 1) / Math.max(1, total)) / spineLength()) * 100);
    };

    // Sottolineature: disegnate direttamente sulle viste, saltando i CFI che epub.js non sa leggere.
    const drawn = new Set<string>();
    const skipped = new Set<string>();
    const paintView = (view: MarkView) => {
      if (!view.contents) return;
      for (const cfi of Object.keys(view.highlights)) view.unhighlight(cfi);
      for (const cfi of Object.keys(view.underlines)) view.ununderline(cfi);
      for (const item of live.current.fileHighlights) {
        if (spinePosOf(item.location) !== view.index) continue;
        try {
          // Un CFI che punta a un altro testo (file diverso da quello annotato in Apple Books) non si disegna.
          const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
          const found = squash(view.contents.range(item.location).toString());
          const wanted = squash(item.text);
          if (!found || !(found.includes(wanted) || wanted.includes(found))) throw new Error('testo diverso');
          const style = markStyle(item.color, live.current.themeName, READER_THEMES[live.current.themeName].text);
          const className = style.kind === 'underline' ? 'books-ul' : 'books-hl';
          if (style.kind === 'underline') view.underline(item.location, {}, undefined, className, style.attrs);
          else view.highlight(item.location, {}, undefined, className, style.attrs);
          drawn.add(item.id);
          skipped.delete(item.id);
        } catch {
          if (!skipped.has(item.id)) {
            skipped.add(item.id);
            console.info(`[lettore] sottolineatura non applicabile (posizione non valida): ${item.id}`);
          }
        }
      }
    };
    paintAll.current = () => {
      if (cancelled) return;
      // Prima dell'apertura il gestore delle viste non esiste ancora: niente da ridisegnare.
      const views = rendition.views() as unknown as { all?: () => MarkView[] };
      for (const view of views.all?.() ?? []) paintView(view);
    };
    rendition.hooks.render.register((view: MarkView) => paintView(view));

    // Hit test: il tocco su una sottolineatura (coordinate dell'iframe) senza mettere gli SVG sopra il testo.
    const hitTest = (contents: Contents, x: number, y: number): BookHighlight | null => {
      let found: BookHighlight | null = null;
      for (const item of live.current.fileHighlights) {
        if (spinePosOf(item.location) !== contents.sectionIndex) continue;
        try {
          const rects = Array.from(contents.range(item.location).getClientRects());
          const inside = rects.some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
          // Se si sovrappongono, vince la propria (modificabile) su quella di Apple Books.
          if (inside && !(found && found.source !== 'applebooks' && item.source === 'applebooks')) found = item;
        } catch {
          /* posizione non valida: non si tocca */
        }
      }
      return found;
    };

    // Selezione di testo: compare il menu dei colori. Il listener sull'iframe lo attacca il genitore, senza script nel libro.
    rendition.on('selected', (cfiRange: string, contents: Contents) => {
      if (cancelled || live.current.draft !== null) return;
      try {
        const range = contents.range(cfiRange);
        const text = range.toString().trim();
        if (!text) return;
        const index = contents.sectionIndex;
        const chapter =
          [...live.current.toc].reverse().find((entry) => entry.spineIndex >= 0 && entry.spineIndex <= index)?.label ?? '';
        setMenuError('');
        setMenu({ kind: 'new', cfi: cfiRange, text, chapter, rect: rectOf(range, contents) });
      } catch {
        /* selezione non convertibile in posizione: nessun menu */
      }
    });
    rendition.hooks.content.register((contents: Contents) => {
      contents.document.addEventListener('selectionchange', () => {
        const selection = contents.window.getSelection();
        if (selection && !selection.isCollapsed) return;
        if (live.current.draft !== null) return;
        setMenu((current) => (current?.kind === 'new' ? null : current));
      });
    });

    rendition.on('relocated', (location: Location) => {
      if (cancelled) return;
      setMenu(null);
      setDraft(null);
      cfiRef.current = location.start.cfi;
      setSpineIndex(location.start.index);
      const progress = progressOf(location);
      setPercent(locationsReady ? progress : null);
      // La prima posizione e' quella dell'apertura: salvare solo se si legge davvero.
      if (firstRelocation) {
        firstRelocation = false;
        return;
      }
      moved = true;
      live.current.saver.update(location.start.cfi, progress);
    });

    // Percentuali: dalla cache se ci sono, altrimenti in background.
    const onLocationsReady = () => {
      locationsReady = true;
      const current = (rendition as unknown as { location?: Location }).location;
      if (!current || cancelled) return;
      const progress = progressOf(current);
      setPercent(progress);
      if (moved) live.current.saver.update(current.start.cfi, progress);
    };
    const cached = loadCachedLocations(locationKey);
    let cacheLoaded = false;
    if (cached) {
      try {
        book.locations.load(cached);
        cacheLoaded = book.locations.length() > 0;
      } catch {
        cacheLoaded = false;
      }
    }

    // Tasti: dalla pagina e dall'interno dell'iframe del libro.
    const onKey = (event: KeyboardEvent) => {
      const state = live.current;
      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
          go('next');
          break;
        case 'ArrowLeft':
        case 'PageUp':
          go('prev');
          break;
        case ' ':
          go(event.shiftKey ? 'prev' : 'next');
          break;
        case 'Escape':
          if (state.panel) setPanel(null);
          else state.onClose();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    rendition.on('keydown', onKey);

    // Tocco: terzo sinistro/destro girano pagina, il centro mostra o nasconde le barre. Swipe orizzontale: pagina.
    let touchStart: { x: number; y: number } | null = null;
    let swipedAt = 0;
    // Un tocco che chiude il menu (o la selezione) non deve girare pagina.
    let menuTouchedAt = 0;
    rendition.on('mousedown', () => {
      if (live.current.menu) menuTouchedAt = Date.now();
    });
    rendition.on('touchstart', (event: TouchEvent) => {
      if (live.current.menu) menuTouchedAt = Date.now();
      const touch = event.changedTouches[0];
      touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
    });
    rendition.on('touchend', (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch || !touchStart) return;
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swipedAt = Date.now();
        go(dx < 0 ? 'next' : 'prev');
      }
    });
    rendition.on('click', (event: MouseEvent, contents: Contents) => {
      if (Date.now() - swipedAt < 500 || Date.now() - menuTouchedAt < 600) return;
      if ((event.target as Element | null)?.closest?.('a[href]')) return;
      if (contents.window.getSelection()?.toString()) return;
      const hit = hitTest(contents, event.clientX, event.clientY);
      if (hit) {
        setDraft(null);
        setMenuError('');
        let rect: MenuRect | null = null;
        try {
          rect = rectOf(contents.range(hit.location), contents);
        } catch {
          /* il menu si mostra senza ancoraggio */
        }
        setMenu({ kind: 'edit', id: hit.id, rect });
        return;
      }
      if (live.current.menu) {
        setMenu(null);
        setDraft(null);
        return;
      }
      if (live.current.panel) {
        setPanel(null);
        return;
      }
      // Le coordinate del clic sono quelle dell'iframe, che scorre dentro il contenitore.
      const frame = contents.window.frameElement as HTMLElement | null;
      const box = container.getBoundingClientRect();
      const x = (frame?.getBoundingClientRect().left ?? box.left) + event.clientX;
      const ratio = (x - box.left) / Math.max(1, box.width);
      if (ratio < 1 / 3) go('prev');
      else if (ratio > 2 / 3) go('next');
      else setBars((visible) => !visible);
    });

    book.loaded.navigation
      .then((navigation) => {
        if (!cancelled) setToc(flattenToc(book, navigation.toc));
      })
      .catch(() => undefined);

    // Un EPUB troncato puo' non dare mai errore: dopo un po' si smette di aspettare.
    let shown = false;
    const watchdog = window.setTimeout(() => {
      if (!shown && !cancelled) setError('Il file EPUB non si apre: potrebbe essere danneggiato.');
    }, OPEN_TIMEOUT_MS);

    const saved = startLocation || meta.readingPositions?.[file]?.location;
    const opening = book.ready
      .then(() => rendition.display(saved || undefined).catch(() => rendition.display()))
      .then(() => {
        if (cancelled) return undefined;
        shown = true;
        window.clearTimeout(watchdog);
        setOpened(true);
        if (cacheLoaded) {
          onLocationsReady();
          return undefined;
        }
        // Generare le percentuali puo' richiedere secondi: in background, con pause brevi.
        (book.locations as unknown as { pause: number }).pause = 10;
        return book.locations.generate(LOCATION_CHARS).then(() => {
          if (cancelled) return;
          try {
            storeLocations(locationKey, book.locations.save());
          } catch {
            /* nessuna cache */
          }
          onLocationsReady();
        });
      })
      .catch(() => {
        if (!cancelled) setError('Impossibile aprire questo EPUB: il file sembra danneggiato.');
      });
    void opening;

    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      window.removeEventListener('keydown', onKey);
      renditionRef.current = null;
      paintAll.current = () => undefined;
      try {
        rendition.destroy();
        book.destroy();
      } catch {
        /* gia' smontato */
      }
    };
    // Il libro si apre una volta per file: tema e dimensione si applicano a parte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, meta.id, file]);

  // Tema e dimensione del testo: si applicano subito e si ricordano.
  useEffect(() => {
    renditionRef.current?.themes.select(themeName);
    storeTheme(themeName);
    paintAll.current();
  }, [themeName]);
  // Le sottolineature si ridisegnano a ogni modifica.
  useEffect(() => {
    paintAll.current();
  }, [fileHighlights, opened]);
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    rendition.themes.fontSize(`${fontSize}%`);
    storeFontSize(fontSize);
    // Il testo si riadatta: si torna dov'era il lettore.
    const cfi = cfiRef.current;
    if (cfi) window.setTimeout(() => void renditionRef.current?.display(cfi), 50);
    window.setTimeout(() => paintAll.current(), 400);
  }, [fontSize]);

  /** Aggiorna elenco locale e store (scheda Sottolineature del dettaglio). */
  const applyHighlights = (next: BookHighlight[]) => {
    setHighlights(next);
    useStore.getState().setHighlights(meta.id, next);
  };

  const clearSelection = () => {
    try {
      (renditionRef.current?.getContents() as unknown as Contents[] | undefined)?.forEach((contents) =>
        contents.window.getSelection()?.removeAllRanges(),
      );
    } catch {
      /* nessuna selezione da togliere */
    }
  };

  const createHighlight = async (color: HighlightColor, note: string) => {
    if (menu?.kind !== 'new') return;
    setMenuError('');
    try {
      const created = await api.createHighlight(meta.id, {
        file,
        location: menu.cfi,
        text: menu.text,
        color,
        note: note.trim() || undefined,
        chapter: menu.chapter || undefined,
      });
      // Il server le tiene in ordine di lettura: si rilegge l'elenco, con ripiego sull'aggiunta in coda.
      const list = await api
        .book(meta.id)
        .then((fresh) => fresh.highlights ?? [])
        .catch(() => [...highlights, created]);
      applyHighlights(list);
      clearSelection();
      closeMenu();
    } catch (failure) {
      setMenuError((failure as Error).message || 'Sottolineatura non salvata');
    }
  };

  const updateHighlight = async (id: string, patch: { color?: HighlightColor; note?: string }) => {
    setMenuError('');
    try {
      const updated = await api.updateHighlight(meta.id, id, patch);
      applyHighlights(highlights.map((item) => (item.id === id ? updated : item)));
    } catch (failure) {
      setMenuError((failure as Error).message || 'Modifica non salvata');
    }
  };

  const deleteHighlight = async (id: string) => {
    setMenuError('');
    try {
      await api.deleteHighlight(meta.id, id);
      applyHighlights(highlights.filter((item) => item.id !== id));
      closeMenu();
    } catch (failure) {
      setMenuError((failure as Error).message || 'Eliminazione non riuscita');
    }
  };

  const copyText = (text: string) => {
    if (!navigator.clipboard) {
      setMenuError('Appunti non disponibili in questo contesto');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => {
        clearSelection();
        closeMenu();
      },
      () => setMenuError('Impossibile copiare negli appunti'),
    );
  };

  const goToHighlight = (item: BookHighlight) => {
    setPanel(null);
    void renditionRef.current?.display(item.location).catch(() => undefined);
  };

  const editing = menu?.kind === 'edit' ? highlights.find((item) => item.id === menu.id) ?? null : null;

  const chapter =
    spineIndex >= 0
      ? [...toc].reverse().find((entry) => entry.spineIndex >= 0 && entry.spineIndex <= spineIndex)?.label ?? ''
      : '';
  const status = [chapter, percent === null ? 'calcolo…' : `${Math.round(percent)}%`].filter(Boolean).join(' · ');

  if (error) {
    return <ReaderMessage theme={theme} title="Impossibile aprire il libro" detail={error} error onClose={onClose} />;
  }

  const safeTop = 'env(safe-area-inset-top)';
  const safeBottom = 'env(safe-area-inset-bottom)';

  return (
    <div className="absolute inset-0 select-none" style={{ background: theme.background, color: theme.text }}>
      <div
        ref={containerRef}
        className="absolute inset-x-2 sm:inset-x-6"
        style={{ top: `calc(${BAR_HEIGHT}px + ${safeTop})`, bottom: `calc(${BAR_HEIGHT}px + ${safeBottom})` }}
      />

      {!opened && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]" style={{ color: theme.muted }}>
          Apro il libro…
        </div>
      )}

      {/* Riga di stato sempre visibile, nel margine in basso. */}
      <div
        className="pointer-events-none absolute inset-x-0 truncate px-4 text-center text-[11px]"
        style={{ bottom: `calc(${safeBottom} + 14px)`, color: theme.muted, opacity: bars ? 0 : 1 }}
      >
        {status}
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
          onClick={() => setPanel(panel === 'toc' ? null : 'toc')}
          aria-label="Indice"
          title="Indice"
          disabled={toc.length === 0}
        >
          Indice
        </ReaderButton>
        <ReaderButton
          onClick={() => setPanel(panel === 'highlights' ? null : 'highlights')}
          aria-label="Sottolineature"
          title="Sottolineature"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 11-5 5v3h3l5-5" />
            <path d="m14 6 4 4-6.5 6.5-4-4z" />
            <path d="M4 22h16" />
          </svg>
        </ReaderButton>
        <ReaderButton
          onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
          aria-label="Testo e tema"
          title="Testo e tema"
        >
          Aa
        </ReaderButton>
      </div>

      <div
        className="absolute inset-x-0 z-10 flex items-center justify-between gap-2 border-t px-2"
        style={{ ...barStyle(theme, 'bottom', bars), height: `calc(${BAR_HEIGHT}px + ${safeBottom})` }}
      >
        <ReaderButton onClick={() => go('prev')} aria-label="Pagina precedente" title="Pagina precedente">
          <ChevronLeft />
        </ReaderButton>
        <p className="min-w-0 flex-1 truncate text-center text-[12px]" style={{ color: theme.muted }}>
          {status}
        </p>
        <ReaderButton onClick={() => go('next')} aria-label="Pagina successiva" title="Pagina successiva">
          <ChevronRight />
        </ReaderButton>
      </div>

      {panel === 'settings' && (
        <div
          className="absolute right-2 z-20 w-72 max-w-[calc(100%-1rem)] rounded-2xl border p-3 shadow-panel"
          style={{
            top: `calc(${BAR_HEIGHT}px + ${safeTop} + 4px)`,
            background: theme.panel,
            borderColor: theme.border,
          }}
        >
          <p className="mb-1.5 text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
            Dimensione del testo
          </p>
          <div className="flex items-center justify-between gap-2">
            <ReaderButton
              onClick={() => setFontSize((value) => Math.max(FONT_SIZES.min, value - FONT_SIZES.step))}
              disabled={fontSize <= FONT_SIZES.min}
              aria-label="Riduci il testo"
              className="border"
              style={{ borderColor: theme.border }}
            >
              A−
            </ReaderButton>
            <span className="text-[13px] tabular-nums">{fontSize}%</span>
            <ReaderButton
              onClick={() => setFontSize((value) => Math.min(FONT_SIZES.max, value + FONT_SIZES.step))}
              disabled={fontSize >= FONT_SIZES.max}
              aria-label="Ingrandisci il testo"
              className="border"
              style={{ borderColor: theme.border }}
            >
              A+
            </ReaderButton>
          </div>
          <p className="mb-1.5 mt-3 text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
            Tema
          </p>
          <div className="flex gap-2">
            {(Object.entries(READER_THEMES) as [ReaderThemeName, ReaderTheme][]).map(([name, value]) => (
              <button
                key={name}
                type="button"
                onClick={() => setThemeName(name)}
                className={cn(
                  'h-10 flex-1 rounded-xl border text-[12px] font-medium',
                  themeName === name && 'ring-2 ring-accent-500',
                )}
                style={{ background: value.background, color: value.text, borderColor: value.border }}
              >
                {value.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {panel === 'highlights' && (
        <HighlightsPanel
          theme={theme}
          highlights={fileHighlights}
          safeTop={safeTop}
          safeBottom={safeBottom}
          onGo={goToHighlight}
          onClose={() => setPanel(null)}
        />
      )}

      {menu && (menu.kind === 'new' || editing) && (
        <HighlightMenu
          key={menu.kind === 'new' ? menu.cfi : menu.id}
          theme={theme}
          state={menu}
          highlight={editing}
          sheet={sheet}
          draft={draft}
          onDraft={setDraft}
          error={menuError}
          onCreate={(color, note) => void createHighlight(color, note)}
          onCopy={() => menu.kind === 'new' && copyText(menu.text)}
          onColor={(color) => editing && void updateHighlight(editing.id, { color })}
          onNote={(note) => editing && void updateHighlight(editing.id, { note })}
          onDelete={() => editing && void deleteHighlight(editing.id)}
          onClose={() => {
            if (menu.kind === 'new') clearSelection();
            closeMenu();
          }}
        />
      )}

      {panel === 'toc' && (
        <div className="absolute inset-0 z-20 flex" onClick={() => setPanel(null)}>
          <nav
            className="flex h-full w-80 max-w-[85%] flex-col border-r shadow-panel"
            style={{ background: theme.panel, borderColor: theme.border, color: theme.text }}
            onClick={(event) => event.stopPropagation()}
            aria-label="Indice"
          >
            <div
              className="flex items-center justify-between border-b px-3"
              style={{ borderColor: theme.border, paddingTop: safeTop, height: `calc(${BAR_HEIGHT}px + ${safeTop})` }}
            >
              <span className="text-[14px] font-semibold">Indice</span>
              <ReaderButton onClick={() => setPanel(null)} aria-label="Chiudi l'indice">
                <CloseIcon />
              </ReaderButton>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" style={{ paddingBottom: safeBottom }}>
              {toc.map((entry, index) => {
                const current =
                  entry.spineIndex >= 0 &&
                  entry.label === chapter &&
                  entry.spineIndex <= spineIndex;
                return (
                  <li key={`${entry.href}-${index}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setPanel(null);
                        void renditionRef.current?.display(entry.href);
                      }}
                      className={cn(
                        'block min-h-[2.5rem] w-full py-2 pr-4 text-left text-[13px] hover:bg-black/[0.06]',
                        current && 'font-semibold',
                      )}
                      style={{ paddingLeft: `${16 + entry.depth * 16}px` }}
                    >
                      {entry.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}
