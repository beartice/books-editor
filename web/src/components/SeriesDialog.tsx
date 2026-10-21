import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookSummary, SeriesVolume } from '@shared/types';
import { api } from '../api';
import {
  buildSeriesGroups,
  buildSeriesRows,
  formatReleaseDate,
  normalizeSeriesName,
} from '../series';
import type { SeriesGroup, SeriesRow } from '../series';
import { useStore } from '../store';
import { cn } from '../utils';
import {
  IconCalendar,
  IconChevron,
  IconClose,
  IconLayers,
  IconLink,
  IconRefresh,
  IconSearch,
} from './icons';

interface Props {
  onClose: () => void;
  initialSeries?: string | null;
}

interface LookupState {
  status: 'loading' | 'done' | 'error';
  volumes: SeriesVolume[];
  errors: string[];
}

const TOTALS_STORAGE_KEY = 'books-editor.series-totals.v1';

/** Lettura una tantum dei totali che prima stavano nel browser (migrazione al server). */
function readLegacyTotals(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(TOTALS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const legacy: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        legacy[key] = Math.min(500, Math.floor(value));
      }
    }
    return legacy;
  } catch {
    return {};
  }
}

function clearLegacyTotals(): void {
  try {
    window.localStorage.removeItem(TOTALS_STORAGE_KEY);
  } catch {
    // Storage non disponibile: nessun problema, la chiave resta dov'e'.
  }
}

function isQuotaError(message: string): boolean {
  return /quota|429/i.test(message);
}

function canLookupGroup(group: SeriesGroup): boolean {
  return group.hasBookKind || group.ao3Urls.length > 0;
}

function groupNouns(group: SeriesGroup): { one: string; many: string } {
  return group.hasBookKind ? { one: 'volume', many: 'volumi' } : { one: 'opera', many: 'opere' };
}

export default function SeriesDialog({ onClose, initialSeries }: Props) {
  const books = useStore((state) => state.books);
  const select = useStore((state) => state.select);
  const seriesRefreshDays = useStore((state) => state.settings?.seriesRefreshDays ?? 30);
  const groups = useMemo(() => buildSeriesGroups(books), [books]);
  const initialKey = initialSeries ? normalizeSeriesName(initialSeries) : null;

  const [selectedKey, setSelectedKey] = useState<string | null>(() => {
    const requested = initialKey ? groups.find((group) => group.key === initialKey) : undefined;
    return requested?.key ?? groups[0]?.key ?? null;
  });
  const [query, setQuery] = useState('');
  const [lookups, setLookups] = useState<Record<string, LookupState>>({});
  const [totals, setTotals] = useState<Record<string, number>>({});
  // Totali e cache letti dal server: la coda in background parte solo dopo.
  const [preloaded, setPreloaded] = useState(false);
  const quotaHit = useRef(false);
  const mounted = useRef(true);
  const pending = useRef(new Set<string>());
  const lookupsRef = useRef(lookups);
  lookupsRef.current = lookups;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (selectedKey && groups.some((group) => group.key === selectedKey)) return;
    const requested = initialKey ? groups.find((group) => group.key === initialKey) : undefined;
    setSelectedKey(requested?.key ?? groups[0]?.key ?? null);
  }, [groups, initialKey, selectedKey]);

  const filteredGroups = useMemo(() => {
    const needle = normalizeSeriesName(query);
    if (!needle) return groups;
    return groups.filter((group) =>
      [group.name, ...group.authors].some((value) =>
        normalizeSeriesName(value).includes(needle),
      ),
    );
  }, [groups, query]);

  const selected = groups.find((group) => group.key === selectedKey) ?? null;
  const nouns = selected ? groupNouns(selected) : { one: 'volume', many: 'volumi' };

  const requestLookup = async (group: SeriesGroup, refresh = false): Promise<boolean> => {
    // Restituisce false se la ricerca e' fallita per quota Google esaurita.
    if (!canLookupGroup(group)) return true;
    const current = lookups[group.key];
    if (!refresh && current && (current.status === 'loading' || current.status === 'done')) return true;
    if (pending.current.has(group.key)) return true;

    pending.current.add(group.key);
    setLookups((previous) => ({
      ...previous,
      [group.key]: { status: 'loading', volumes: [], errors: [] },
    }));

    try {
      const result = await api.seriesLookup(group.name, group.authors, {
        isbns: group.isbns,
        ao3Urls: group.ao3Urls,
        kind: group.hasBookKind ? 'book' : 'fanfic',
        refresh,
      });
      if (!mounted.current) return true;
      setLookups((previous) => ({
        ...previous,
        [group.key]: { status: 'done', volumes: result.volumes, errors: result.errors },
      }));
      return !result.errors.some(isQuotaError);
    } catch (error) {
      if (!mounted.current) return true;
      setLookups((previous) => ({
        ...previous,
        [group.key]: {
          status: 'error',
          volumes: [],
          errors: [(error as Error).message],
        },
      }));
      return !isQuotaError((error as Error).message);
    } finally {
      pending.current.delete(group.key);
    }
  };

  useEffect(() => {
    if (!selected || !canLookupGroup(selected)) return;
    if (lookups[selected.key]) return;
    void requestLookup(selected);
    // La ricerca parte una volta sola quando si apre una serie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key]);

  // All'apertura: totali dal server (con migrazione da localStorage) e risultati
  // gia' salvati in cache, cosi' i mancanti compaiono subito per tutte le serie.
  useEffect(() => {
    void (async () => {
      try {
        let serverTotals = await api.seriesTotals();
        const legacy = readLegacyTotals();
        if (Object.keys(serverTotals).length === 0 && Object.keys(legacy).length > 0) {
          for (const [key, value] of Object.entries(legacy)) {
            serverTotals = await api.setSeriesTotal(key, value);
          }
          clearLegacyTotals();
        }
        if (mounted.current) setTotals((previous) => ({ ...serverTotals, ...previous }));
      } catch (error) {
        useStore.getState().toast((error as Error).message, 'error');
      }

      try {
        const lookable = groups.filter(canLookupGroup);
        if (lookable.length > 0) {
          const { results } = await api.seriesCached(
            lookable.map((group) => ({
              series: group.name,
              authors: group.authors,
              kind: group.hasBookKind ? 'book' : 'fanfic',
            })),
          );
          if (!mounted.current) return;
          setLookups((previous) => {
            const next = { ...previous };
            lookable.forEach((group, index) => {
              const hit = results[index];
              if (hit && !next[group.key]) {
                next[group.key] = { status: 'done', volumes: hit.volumes, errors: [] };
              }
            });
            return next;
          });
        }
      } catch {
        // La cache e' solo un anticipo: le ricerche in background coprono il resto.
      }
      if (mounted.current) setPreloaded(true);
    })();
    // Solo all'apertura della finestra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ricerca in background, una serie alla volta, delle serie senza risultati salvati.
  // Si ferma alla chiusura e, per questa apertura, se la quota Google e' esaurita.
  useEffect(() => {
    if (!preloaded) return;
    void (async () => {
      for (const group of groups) {
        if (!mounted.current || quotaHit.current) return;
        if (!canLookupGroup(group) || lookupsRef.current[group.key]) continue;
        const ok = await requestLookup(group);
        if (!ok) quotaHit.current = true;
      }
    })();
    // La coda parte una volta sola, dopo il precaricamento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloaded]);

  const lookup = selected ? lookups[selected.key] : undefined;
  const totalVolumes = selected ? (totals[selected.key] ?? 0) : 0;
  const onlineVolumes = useMemo(
    () => (lookup?.status === 'done' ? lookup.volumes : []),
    [lookup],
  );
  const rows = useMemo(
    () => (selected ? buildSeriesRows(selected, onlineVolumes, totalVolumes) : []),
    [selected, onlineVolumes, totalVolumes],
  );
  const numberedRows = rows.filter((row) => row.index !== null);
  const extraRows = rows.filter((row) => row.index === null);
  const missingCount = rows.filter((row) => !row.owned && row.index !== null).length;
  const sources = [...new Set(onlineVolumes.map((volume) => volume.providerLabel))];

  // Mancanti di tutte le serie, calcolati una volta sola.
  const missingByGroup = useMemo(() => {
    const result: Record<string, SeriesRow[]> = {};
    for (const group of groups) {
      const groupLookup = lookups[group.key];
      const volumes = groupLookup?.status === 'done' ? groupLookup.volumes : [];
      result[group.key] = buildSeriesRows(group, volumes, totals[group.key] ?? 0).filter(
        (row) => !row.owned && row.index !== null,
      );
    }
    return result;
  }, [groups, lookups, totals]);

  const openBook = (book: BookSummary) => {
    onClose();
    void select(book.id);
  };

  const updateTotal = (key: string, rawValue: string) => {
    const parsed = Number(rawValue);
    const value =
      rawValue.trim() && Number.isFinite(parsed) && parsed > 0
        ? Math.min(500, Math.floor(parsed))
        : null;
    // Aggiornamento subito visibile; il salvataggio sul server segue.
    setTotals((previous) => {
      const next = { ...previous };
      if (value !== null) next[key] = value;
      else delete next[key];
      return next;
    });
    api.setSeriesTotal(key, value).catch((error: Error) => {
      useStore.getState().toast(error.message, 'error');
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/30 backdrop-blur-[3px]"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="series-dialog-title"
        className="relative flex h-full w-full max-w-6xl animate-fade-in flex-col overflow-hidden border border-black/[0.07] bg-white shadow-panel sm:h-[92vh] sm:max-h-[920px] sm:rounded-[30px]"
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-black/[0.06] px-4 py-4 sm:px-6">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-coral-500 text-white shadow-sm">
            <IconLayers className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">La tua raccolta</p>
            <h2
              id="series-dialog-title"
              className="mt-0.5 text-xl font-semibold tracking-[-0.03em] text-ink-50"
            >
              Serie
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-500">
              Volumi e opere posseduti, mancanti e date di pubblicazione disponibili.
            </p>
          </div>
          <button onClick={onClose} className="btn-subtle px-2" aria-label="Chiudi serie">
            <IconClose />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)] md:grid-rows-1">
          <aside className="flex min-h-0 flex-col border-b border-black/[0.06] bg-[#fbf8f1] md:border-b-0 md:border-r">
            <div className="shrink-0 p-3 pb-2">
              <div className="relative">
                <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Cerca una serie…"
                  className="field-input w-full pl-9 text-[13px]"
                />
              </div>
              <div className="mt-2 flex items-center justify-between px-1">
                <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-500">
                  Le tue serie
                </p>
                <span className="text-[10px] tabular-nums text-ink-500">{groups.length}</span>
              </div>
            </div>

            <div className="min-h-0 max-h-52 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 md:max-h-none">
              {filteredGroups.length === 0 ? (
                <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-ink-500">
                  {groups.length === 0
                    ? 'Nessuna serie presente. Aggiungi il nome della serie nei dettagli di un libro.'
                    : 'Nessuna serie corrisponde alla ricerca.'}
                </p>
              ) : (
                <div className="space-y-1">
                  {filteredGroups.map((group) => {
                    const active = group.key === selectedKey;
                    const missingPreview = missingByGroup[group.key]?.length ?? 0;
                    const searching = lookups[group.key]?.status === 'loading';
                    const nouns = groupNouns(group);
                    return (
                      <button
                        key={group.key}
                        onClick={() => setSelectedKey(group.key)}
                        className={cn(
                          'group flex w-full items-center gap-2.5 rounded-2xl border px-2.5 py-2.5 text-left transition',
                          active
                            ? 'border-coral-500/20 bg-[#fbeee7] shadow-sm'
                            : 'border-transparent hover:bg-white/80',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition',
                            active
                              ? 'bg-coral-500 text-white'
                              : 'bg-white text-ink-400 shadow-sm group-hover:text-coral-600',
                          )}
                        >
                          <IconLayers className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-semibold text-ink-100">
                            {group.name}
                          </span>
                          <span className="mt-0.5 block truncate text-[10.5px] text-ink-500">
                            {group.authors.join(', ') || 'Autore sconosciuto'}
                          </span>
                          <span className="mt-1 flex items-center gap-1.5">
                            <span className="text-[10px] text-ink-500">
                              {group.books.length}{' '}
                              {group.books.length === 1 ? nouns.one : nouns.many}
                            </span>
                            {missingPreview > 0 && (
                              <span className="rounded-full bg-coral-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-coral-700">
                                {missingPreview} mancanti
                              </span>
                            )}
                            {group.hasFanfic && (
                              <span className="rounded-full bg-white px-1.5 py-0.5 text-[9px] font-medium text-ink-500">
                                fanfic
                              </span>
                            )}
                            {searching && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-accent-700">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-500" />
                                cerco…
                              </span>
                            )}
                          </span>
                        </span>
                        <IconChevron
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 text-ink-500 transition',
                            active && 'text-coral-600',
                          )}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <p className="hidden shrink-0 border-t border-black/[0.05] px-4 py-3 text-[10px] leading-relaxed text-ink-500 md:block">
              Le serie sono ricavate dal campo <strong>Serie</strong> dei metadati. I risultati
              online vengono salvati sul server; le serie senza risultati salvati vengono
              cercate in background, una alla volta.
            </p>
          </aside>

          <div className="min-h-0 overflow-y-auto overscroll-contain bg-white p-4 sm:p-6">
            {!selected ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f7f2e8] text-coral-600">
                  <IconLayers className="h-6 w-6" />
                </span>
                <p className="text-sm font-medium text-ink-200">Seleziona una serie</p>
                <p className="max-w-sm text-xs leading-relaxed text-ink-500">
                  Qui vedrai cosa possiedi, cosa manca e le date disponibili online.
                </p>
              </div>
            ) : (
              <div className="animate-fade-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="eyebrow">Serie</p>
                    <h3 className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.03em] text-ink-50">
                      {selected.name}
                    </h3>
                    <p className="mt-1 text-[12px] text-ink-500">
                      {selected.authors.join(', ') || 'Autore sconosciuto'}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <span className="chip bg-accent-500/10 text-accent-700">
                        {selected.books.length}{' '}
                        {selected.books.length === 1 ? nouns.one : nouns.many} nella libreria
                      </span>
                      {missingCount > 0 && (
                        <span className="chip border-coral-500/20 bg-coral-500/10 text-coral-700">
                          {missingCount} {missingCount === 1 ? 'mancante' : 'mancanti'}
                        </span>
                      )}
                      {extraRows.length > 0 && (
                        <span className="chip">
                          {extraRows.length} {selected.hasBookKind ? 'altri' : 'altre'} online
                        </span>
                      )}
                      {selected.hasFanfic && (
                        <span className="chip border-rose-500/20 bg-rose-500/10 text-rose-600">
                          fanfiction
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      className="flex items-center gap-2 rounded-xl border border-black/[0.07] bg-[#fbf8f1] px-2.5 py-1.5 text-[10px] font-medium text-ink-500"
                      title={`Serve a mostrare le ${nouns.many} mancanti quando la serie non è indicizzata online.`}
                    >
                      Totale {nouns.many}
                      <input
                        key={`total:${selected.key}`}
                        type="number"
                        min={1}
                        max={500}
                        inputMode="numeric"
                        defaultValue={totalVolumes || ''}
                        placeholder="auto"
                        aria-label={`Numero totale di ${nouns.many} della serie`}
                        onBlur={(event) => {
                          const raw = event.currentTarget.value.trim();
                          const parsed = Number(raw);
                          const normalized =
                            raw && Number.isFinite(parsed) && parsed > 0
                              ? String(Math.min(500, Math.floor(parsed)))
                              : '';
                          event.currentTarget.value = normalized;
                          updateTotal(selected.key, normalized);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                        }}
                        className="w-11 bg-transparent text-right text-[12px] font-semibold tabular-nums text-ink-100 outline-none placeholder:font-normal placeholder:text-ink-400"
                      />
                    </label>
                    {canLookupGroup(selected) && (
                      <button
                        onClick={() => void requestLookup(selected, true)}
                        disabled={lookup?.status === 'loading'}
                        className="btn-ghost shrink-0 text-[12px]"
                      >
                        <IconRefresh
                          className={cn('h-4 w-4', lookup?.status === 'loading' && 'animate-spin')}
                        />
                        {lookup?.status === 'loading' ? 'Cerco…' : 'Aggiorna online'}
                      </button>
                    )}
                  </div>
                </div>

                <LookupNotice
                  group={selected}
                  lookup={lookup}
                  volumeCount={onlineVolumes.length}
                  totalVolumes={totalVolumes}
                  sources={sources}
                  onRetry={() => void requestLookup(selected, true)}
                />

                <div className="mt-5 space-y-2.5">
                  {numberedRows.map((row) => (
                    <VolumeRow
                      key={row.key}
                      row={row}
                      fanfic={!selected.hasBookKind}
                      onOpenBook={openBook}
                    />
                  ))}

                  {extraRows.length > 0 && (
                    <div className="pt-2">
                      <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
                        {selected.hasBookKind
                          ? 'Altri volumi trovati online'
                          : 'Altre opere trovate online'}
                      </p>
                      <div className="space-y-2.5">
                        {extraRows.map((row) => (
                          <VolumeRow
                            key={row.key}
                            row={row}
                            fanfic={!selected.hasBookKind}
                            onOpenBook={openBook}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <p className="mt-6 border-t border-black/[0.06] pt-3 text-[10.5px] leading-relaxed text-ink-500">
                  Le date provengono da fonti online e possono variare tra edizioni, ristampe e
                  traduzioni.{' '}
                  {selected.hasBookKind
                    ? 'I volumi mancanti non vengono aggiunti alla libreria.'
                    : 'Le opere mancanti non vengono aggiunte alla libreria.'}{' '}
                  I risultati restano in cache per {seriesRefreshDays} giorni; «Aggiorna online»
                  li ricalcola.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LookupNotice({
  group,
  lookup,
  volumeCount,
  totalVolumes,
  sources,
  onRetry,
}: {
  group: SeriesGroup;
  lookup: LookupState | undefined;
  volumeCount: number;
  totalVolumes: number;
  sources: string[];
  onRetry: () => void;
}) {
  const fanficOnly = !group.hasBookKind;
  const one = fanficOnly ? 'opera' : 'volume';
  const many = fanficOnly ? 'opere' : 'volumi';
  const extra = fanficOnly ? 'aggiuntive' : 'aggiuntivi';
  const those = fanficOnly ? 'quelle' : 'quelli';
  const found = fanficOnly ? 'Trovate' : 'Trovati';

  if (fanficOnly && group.ao3Urls.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-black/[0.06] bg-[#fbf8f1] px-3.5 py-3 text-[11px] leading-relaxed text-ink-500">
        Questa è una serie di fanfiction. Per cercare le opere mancanti online, aggiungi il
        link AO3 a una delle opere nella scheda <strong>Metadati</strong>. Gli eventuali
        numeri mancanti nella serie vengono comunque mostrati.
      </div>
    );
  }

  if (lookup?.status === 'loading') {
    return (
      <div className="mt-4 flex items-center gap-2.5 rounded-2xl border border-accent-500/15 bg-accent-500/[0.06] px-3.5 py-3 text-[11px] text-accent-700">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent-500" />
        Cerco le {many} mancanti online…
      </div>
    );
  }

  if (lookup?.status === 'error') {
    return (
      <div className="mt-4 rounded-2xl border border-coral-500/20 bg-coral-500/[0.06] px-3.5 py-3">
        <p className="text-[11px] font-medium text-coral-700">
          Non sono riuscito a completare la ricerca online.
        </p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink-500">
          {lookup.errors.join(' · ')}
        </p>
        <button
          onClick={onRetry}
          className="mt-2 text-[11px] font-semibold text-coral-700 underline-offset-2 hover:underline"
        >
          Riprova
        </button>
      </div>
    );
  }

  if (lookup?.status === 'done') {
    if (lookup.errors.length > 0) {
      return (
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/[0.07] px-3.5 py-3 text-[10.5px] leading-relaxed text-amber-800">
          <p>
            Alcune fonti non hanno risposto: le {many} mostrate potrebbero essere incomplete.
            {volumeCount > 0 && ` Le fonti disponibili hanno restituito le ${many} qui sotto.`}
          </p>
          {volumeCount === 0 && (
            <p className="mt-1">
              {totalVolumes > 0
                ? `Uso il totale di ${totalVolumes} ${many} che hai indicato per mostrarti ${those} mancanti.`
                : `Se conosci il numero totale di ${many}, indicalo in «Totale ${many}» per vedere ${those} mancanti.`}
            </p>
          )}
          {!fanficOnly && volumeCount === 0 && group.isbns.length === 0 && (
            <p className="mt-1">
              Per provare anche Goodreads serve un ISBN nella scheda di almeno un volume.
            </p>
          )}
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[10px] font-semibold underline-offset-2 hover:underline">
              Dettagli
            </summary>
            <p className="mt-1 text-[10px] leading-relaxed">{lookup.errors.join(' · ')}</p>
          </details>
        </div>
      );
    }
    if (volumeCount === 0) {
      return (
        <div className="mt-4 rounded-2xl border border-black/[0.06] bg-[#fbf8f1] px-3.5 py-3 text-[11px] leading-relaxed text-ink-500">
          <p>
            Non ho trovato {many} {extra} online per questa serie.
            {totalVolumes > 0
              ? ` Uso il totale di ${totalVolumes} ${many} che hai indicato per mostrarti ${those} mancanti.`
              : ` Se conosci il numero totale di ${many}, indicalo in «Totale ${many}» per vedere ${those} mancanti.`}
          </p>
          {!fanficOnly && group.isbns.length === 0 && (
            <p className="mt-1.5">
              Per provare anche Goodreads serve un ISBN nella scheda di almeno un volume.
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="mt-4 rounded-2xl border border-accent-500/15 bg-accent-500/[0.06] px-3.5 py-3 text-[11px] leading-relaxed text-accent-700">
        {found} {volumeCount} {volumeCount === 1 ? one : many} online
        {sources.length > 0 ? ` · ${sources.join(' + ')}` : ''}. Quelle non presenti nella tua
        libreria sono indicate come mancanti.
      </div>
    );
  }

  return null;
}

function VolumeRow({
  row,
  fanfic,
  onOpenBook,
}: {
  row: SeriesRow;
  fanfic: boolean;
  onOpenBook: (book: BookSummary) => void;
}) {
  const title =
    row.title ||
    (row.index !== null
      ? `${fanfic ? 'Opera' : 'Volume'} ${row.index}`
      : fanfic
        ? 'Opera non identificata'
        : 'Volume non identificato');
  const date = formatReleaseDate(row.releaseDate);
  const sourceUrl = row.online?.url ?? null;

  return (
    <article
      className={cn(
        'flex items-start gap-3 rounded-[18px] border p-3 transition sm:p-3.5',
        row.owned
          ? 'border-black/[0.06] bg-white shadow-sm'
          : 'border-coral-500/15 bg-[#fffaf7]',
      )}
    >
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl text-[10px] font-bold tabular-nums leading-none',
          row.owned
            ? 'bg-accent-600 text-white shadow-sm'
            : row.index !== null
              ? 'border border-coral-500/20 bg-white text-coral-600'
              : 'bg-[#f3ece1] text-ink-500',
        )}
      >
        {row.index !== null ? (
          <>
            <span className="text-[8px] font-semibold uppercase tracking-wider opacity-75">
              {fanfic ? 'part' : 'vol'}
            </span>
            <span className="mt-0.5 text-[13px]">{row.index}</span>
          </>
        ) : (
          <span className="text-[14px]">—</span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h4 className="text-[13px] font-semibold leading-snug text-ink-100">{title}</h4>
          {row.owned ? (
            <span className="rounded-full bg-accent-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent-700">
              nella libreria
            </span>
          ) : (
            <span className="rounded-full bg-coral-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-coral-700">
              mancante
            </span>
          )}
        </div>

        {row.authors.length > 0 && (
          <p className="mt-0.5 line-clamp-1 text-[10.5px] text-ink-500">
            {row.authors.join(', ')}
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-500">
          <span className="inline-flex items-center gap-1">
            <IconCalendar className="h-3 w-3" />
            {date
              ? `${fanfic ? 'Data di pubblicazione' : 'Data di uscita'}: ${date}`
              : `${fanfic ? 'Data di pubblicazione' : 'Data di uscita'} non disponibile`}
          </span>
          {sourceUrl && row.online && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-accent-700 underline-offset-2 hover:underline"
            >
              <IconLink className="h-3 w-3" />
              {row.online.providerLabel}
            </a>
          )}
        </div>
      </div>

      {row.owned && row.localBook && (
        <button
          onClick={() => onOpenBook(row.localBook!)}
          className="btn-ghost shrink-0 px-2.5 py-1 text-[11px]"
        >
          Apri
        </button>
      )}
    </article>
  );
}
