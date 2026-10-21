import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useStore } from '../store';
import { unmappedTags } from '../genres';
import {
  computeGenreStats,
  computeLanguages,
  computeRatingDistribution,
  computeTimeline,
  computeTiles,
  computeTopAuthors,
  computeTopFandoms,
  finishedYears,
  formatCompact,
  formatRating,
  ratedGenres,
  topGenres,
} from '../stats';
import type { StatsYear, TimePoint } from '../stats';
import { IconChart, IconClose } from './icons';

interface Props {
  onClose: () => void;
}

const BAR_MAX = 24;
const COLUMN_AREA = 120;

const numberFormat = new Intl.NumberFormat('it-IT');

function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['it'], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Codice non riconosciuto: si mostra com'e'.
  }
  return code;
}

/* --- tooltip --- */

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

/** Stato del tooltip di un grafico, con coordinate relative al contenitore. */
function useChartTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (event: MouseEvent, content: ReactNode) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ x: event.clientX - box.left, y: event.clientY - box.top, content });
  };
  const hide = () => setTip(null);
  return { ref, tip, show, hide };
}

function ChartTooltip({ tip, width }: { tip: TipState | null; width: number }) {
  if (!tip) return null;
  const left = tip.x + 190 > width ? Math.max(0, tip.x - 190) : tip.x + 12;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-max max-w-[180px] rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[11px] leading-snug text-ink-100 shadow-panel"
      style={{ left, top: Math.max(0, tip.y - 44) }}
    >
      {tip.content}
    </div>
  );
}

/* --- grafici --- */

interface BarRow {
  key: string;
  name: string;
  value: number;
  /** Testo alla punta della barra («33 · 12 letti»). */
  valueLabel: string;
  tip: ReactNode;
}

/** Barre orizzontali: nome a sinistra, valore alla punta. Una sola serie. */
function HBarChart({ rows, max }: { rows: BarRow[]; max?: number }) {
  const { ref, tip, show, hide } = useChartTip();
  const top = max ?? Math.max(...rows.map((row) => row.value), 0);
  return (
    <div ref={ref} className="relative flex flex-col gap-[2px]" onMouseLeave={hide}>
      {rows.map((row) => {
        const fraction = top > 0 ? row.value / top : 0;
        return (
          <div
            key={row.key}
            className="flex h-6 items-center gap-2 rounded-md px-1 hover:bg-ink-800"
            onMouseMove={(event) => show(event, row.tip)}
          >
            <span className="w-28 shrink-0 truncate text-right text-[11.5px] text-ink-300 sm:w-36">
              {row.name}
            </span>
            <div className="flex min-w-0 flex-1 items-center">
              <div
                className="rounded-r-[4px] bg-accent-500"
                style={{
                  height: Math.min(BAR_MAX, 16),
                  width: `max(2px, calc((100% - 7.5rem) * ${fraction}))`,
                }}
              />
              <span className="ml-2 whitespace-nowrap text-[11px] tabular-nums text-ink-200">
                {row.valueLabel}
              </span>
            </div>
          </div>
        );
      })}
      <ChartTooltip tip={tip} width={ref.current?.clientWidth ?? 320} />
    </div>
  );
}

/** Colonne: valore sopra la colonna solo per il massimo, gli altri nel tooltip. */
function ColumnChart({ points, unit }: { points: TimePoint[]; unit: string }) {
  const { ref, tip, show, hide } = useChartTip();
  const max = Math.max(...points.map((point) => point.value), 0);
  const maxIndex = points.findIndex((point) => point.value === max);
  const dense = points.length > 12;
  return (
    <div ref={ref} className="relative" onMouseLeave={hide}>
      <div className="flex gap-[2px] border-b border-ink-700">
        {points.map((point, index) => (
          <div
            key={point.key}
            className="flex min-w-0 flex-1 flex-col items-center justify-end rounded-t-md hover:bg-ink-800"
            style={{ height: COLUMN_AREA + 18 }}
            onMouseMove={(event) =>
              show(
                event,
                <>
                  <span className="font-medium">{point.label}</span>
                  <br />
                  {numberFormat.format(point.value)} {unit}
                </>,
              )
            }
          >
            {max > 0 && index === maxIndex && (
              <span className="mb-0.5 text-[11px] font-medium tabular-nums text-ink-200">
                {point.value}
              </span>
            )}
            {point.value > 0 && (
              <div
                className="w-full rounded-t-[4px] bg-accent-500"
                style={{ maxWidth: BAR_MAX, height: Math.max(2, (point.value / max) * COLUMN_AREA) }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {points.map((point) => (
          <span
            key={point.key}
            className={`min-w-0 flex-1 truncate text-center tabular-nums text-ink-400 ${
              dense ? 'text-[9.5px]' : 'text-[10.5px]'
            }`}
          >
            {point.label}
          </span>
        ))}
      </div>
      <ChartTooltip tip={tip} width={ref.current?.clientWidth ?? 320} />
    </div>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-3 text-[12px] text-ink-300">
      <summary className="cursor-pointer select-none text-ink-400 hover:text-ink-200">
        Vedi i dati
      </summary>
      <div className="mt-2 max-h-56 overflow-auto">
        <table className="w-full border-collapse text-left tabular-nums">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-ink-700 py-1 pr-3 text-[11px] font-medium text-ink-400"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="border-b border-ink-750 py-1 pr-3">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Card({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-black/[0.06] bg-white p-4">
      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h3>
      {note && <p className="mt-0.5 text-[11.5px] text-ink-500">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-ink-800 px-3 py-4 text-[12px] text-ink-400">{children}</p>;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-black/[0.06] bg-ink-800 px-4 py-3">
      <p className="text-[11px] text-ink-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums tracking-[-0.02em] text-ink-50">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-ink-500">{hint}</p>}
    </div>
  );
}

export default function StatsDialog({ onClose }: Props) {
  const books = useStore((state) => state.books);
  const years = useMemo(() => finishedYears(books), [books]);
  const [year, setYear] = useState<StatsYear>(() => {
    const current = new Date().getFullYear();
    return years.includes(current) ? current : 'all';
  });

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

  const tiles = useMemo(() => computeTiles(books, year), [books, year]);
  const timeline = useMemo(() => computeTimeline(books, year), [books, year]);
  const distribution = useMemo(() => computeRatingDistribution(books), [books]);
  const allGenres = useMemo(() => computeGenreStats(books), [books]);
  const genres = useMemo(() => topGenres(allGenres), [allGenres]);
  const ratedByGenre = useMemo(() => ratedGenres(allGenres), [allGenres]);
  const authors = useMemo(() => computeTopAuthors(books), [books]);
  const fandoms = useMemo(() => computeTopFandoms(books), [books]);
  const languages = useMemo(() => computeLanguages(books), [books]);
  const unmapped = useMemo(() => unmappedTags(books, 12), [books]);

  const yearLabel = year === 'all' ? 'tutti gli anni' : String(year);
  const timelineTotal = timeline.points.reduce((sum, point) => sum + point.value, 0);
  const ratedTotal = distribution.reduce((sum, point) => sum + point.value, 0);
  const genreMax = Math.max(...genres.map((item) => item.count), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/30 backdrop-blur-[3px]"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stats-dialog-title"
        className="relative flex h-full w-full max-w-6xl animate-fade-in flex-col overflow-hidden border border-black/[0.07] bg-white shadow-panel sm:h-[92vh] sm:max-h-[920px] sm:rounded-[30px]"
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-black/[0.06] px-4 py-4 sm:px-6">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-coral-500 text-white shadow-sm">
            <IconChart className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">La tua raccolta</p>
            <h2
              id="stats-dialog-title"
              className="mt-0.5 text-xl font-semibold tracking-[-0.03em] text-ink-50"
            >
              Statistiche
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-500">
              Letture, voti e generi della libreria.
            </p>
          </div>
          <label className="hidden items-center gap-2 text-[12px] text-ink-400 sm:flex">
            Anno
            <select
              value={String(year)}
              onChange={(event) =>
                setYear(event.target.value === 'all' ? 'all' : Number(event.target.value))
              }
              className="field-input text-[13px]"
            >
              <option value="all">Tutti gli anni</option>
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <button onClick={onClose} className="btn-subtle px-2" aria-label="Chiudi statistiche">
            <IconClose />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#fbf8f1] p-4 sm:p-6">
          <label className="mb-4 flex items-center gap-2 text-[12px] text-ink-400 sm:hidden">
            Anno
            <select
              value={String(year)}
              onChange={(event) =>
                setYear(event.target.value === 'all' ? 'all' : Number(event.target.value))
              }
              className="field-input flex-1 text-[13px]"
            >
              <option value="all">Tutti gli anni</option>
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          {books.length === 0 ? (
            <Empty>La libreria è vuota: aggiungi qualche libro per vedere le statistiche.</Empty>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div className="col-span-2 rounded-2xl border border-black/[0.06] bg-white px-4 py-3 md:row-span-2">
                  <p className="text-[11px] text-ink-500">libri letti</p>
                  <p className="mt-1 text-[56px] font-semibold leading-none tabular-nums tracking-[-0.04em] text-ink-50">
                    {numberFormat.format(tiles.read)}
                  </p>
                  <p className="mt-2 text-[11.5px] text-ink-500">
                    {tiles.reread > 0
                      ? `di cui ${numberFormat.format(tiles.reread)} riletture`
                      : 'nessuna rilettura'}
                  </p>
                </div>
                <Tile label="in lettura" value={numberFormat.format(tiles.reading)} />
                <Tile label="da leggere" value={numberFormat.format(tiles.unread)} />
                <Tile label="non finiti" value={numberFormat.format(tiles.dnf)} />
                <Tile
                  label="voto medio"
                  value={tiles.averageRating === null ? '-' : formatRating(tiles.averageRating)}
                  hint={`${numberFormat.format(tiles.ratedCount)} votati`}
                />
                <Tile label="parole lette" value={formatCompact(tiles.wordsRead)} />
                <Tile
                  label="libri nella libreria"
                  value={numberFormat.format(tiles.books)}
                />
                <Tile
                  label="fanfic nella libreria"
                  value={numberFormat.format(tiles.fanfics)}
                />
                <Tile
                  label={year === 'all' ? 'letti con data di fine' : `letti nel ${year}`}
                  value={numberFormat.format(tiles.readInYear)}
                />
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card
                  title={
                    year === 'all' ? 'Libri letti per anno' : `Libri letti per mese nel ${year}`
                  }
                  note={`Periodo: ${yearLabel}`}
                >
                  {timeline.points.length === 0 ? (
                    <Empty>
                      Nessun libro con data di fine lettura: le date arrivano dall'import di Apple
                      Books o si inseriscono in «Finito il» nella scheda.
                    </Empty>
                  ) : (
                    <>
                      <ColumnChart points={timeline.points} unit="letti" />
                      {timelineTotal === 0 && year !== 'all' && (
                        <p className="mt-2 text-[11.5px] text-ink-500">
                          Nessun libro finito nel {year}.
                        </p>
                      )}
                      {timeline.undated > 0 && (
                        <p className="mt-2 text-[11.5px] text-ink-500">
                          {numberFormat.format(timeline.undated)} letti senza data di fine non
                          compaiono nel grafico.
                        </p>
                      )}
                      <DataTable
                        columns={[year === 'all' ? 'Anno' : 'Mese', 'Letti']}
                        rows={timeline.points.map((point) => [point.label, point.value])}
                      />
                    </>
                  )}
                </Card>

                <Card title="Distribuzione dei voti" note="Libri per voto, da 0,5 a 5 stelle">
                  {ratedTotal === 0 ? (
                    <Empty>Nessun libro votato: i voti si danno dalla scheda del libro.</Empty>
                  ) : (
                    <>
                      <ColumnChart points={distribution} unit="libri" />
                      <DataTable
                        columns={['Voto', 'Libri']}
                        rows={distribution.map((point) => [point.label, point.value])}
                      />
                    </>
                  )}
                </Card>

                <Card title="Generi nella libreria" note="Libri per genere · letti">
                  {genres.length === 0 ? (
                    <Empty>Nessun genere riconosciuto: servono tag come «Fantasy» o «Romance».</Empty>
                  ) : (
                    <>
                      <HBarChart
                        max={genreMax}
                        rows={genres.map((item) => ({
                          key: item.genre,
                          name: item.genre,
                          value: item.count,
                          valueLabel: `${item.count} · ${item.read} letti`,
                          tip: (
                            <>
                              <span className="font-medium">{item.genre}</span>
                              <br />
                              {item.count} libri · {item.read} letti
                              <br />
                              {item.averageRating === null
                                ? 'nessun voto'
                                : `voto medio ${formatRating(item.averageRating)} (${item.rated} votati)`}
                            </>
                          ),
                        }))}
                      />
                      <DataTable
                        columns={['Genere', 'Libri', 'Letti', 'Votati', 'Voto medio']}
                        rows={genres.map((item) => [
                          item.genre,
                          item.count,
                          item.read,
                          item.rated,
                          item.averageRating === null ? '-' : formatRating(item.averageRating),
                        ])}
                      />
                    </>
                  )}
                  {unmapped.length > 0 && (
                    <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
                      Tag non classificati più frequenti:{' '}
                      {unmapped.map((item) => `${item.tag} (${item.count})`).join(', ')}
                    </p>
                  )}
                </Card>

                <Card
                  title="Voto medio per genere"
                  note="Solo generi con almeno 3 libri votati"
                >
                  {ratedByGenre.length === 0 ? (
                    <Empty>
                      Nessun genere ha ancora 3 libri votati: il grafico compare quando ce ne sono
                      abbastanza.
                    </Empty>
                  ) : (
                    <>
                      <HBarChart
                        max={5}
                        rows={ratedByGenre.map((item) => ({
                          key: item.genre,
                          name: item.genre,
                          value: item.averageRating ?? 0,
                          valueLabel: formatRating(item.averageRating ?? 0),
                          tip: (
                            <>
                              <span className="font-medium">{item.genre}</span>
                              <br />
                              voto medio {formatRating(item.averageRating ?? 0)}
                              <br />
                              {item.rated} votati · {item.read} letti
                            </>
                          ),
                        }))}
                      />
                      <DataTable
                        columns={['Genere', 'Voto medio', 'Votati']}
                        rows={ratedByGenre.map((item) => [
                          item.genre,
                          formatRating(item.averageRating ?? 0),
                          item.rated,
                        ])}
                      />
                    </>
                  )}
                </Card>

                <Card title="Autori più letti" note="Primi 10 per libri letti">
                  {authors.length === 0 ? (
                    <Empty>Nessun libro letto: segna uno stato «Letto» dalla scheda.</Empty>
                  ) : (
                    <>
                      <HBarChart
                        rows={authors.map((item) => ({
                          key: item.name,
                          name: item.name,
                          value: item.count,
                          valueLabel: String(item.count),
                          tip: (
                            <>
                              <span className="font-medium">{item.name}</span>
                              <br />
                              {item.count} letti
                            </>
                          ),
                        }))}
                      />
                      <DataTable
                        columns={['Autore', 'Letti']}
                        rows={authors.map((item) => [item.name, item.count])}
                      />
                    </>
                  )}
                </Card>

                <Card title="Fandom più presenti" note="Fanfic per fandom, primi 10">
                  {fandoms.length === 0 ? (
                    <Empty>Nessuna fanfic con fandom nella libreria.</Empty>
                  ) : (
                    <>
                      <HBarChart
                        rows={fandoms.map((item) => ({
                          key: item.name,
                          name: item.name,
                          value: item.count,
                          valueLabel: String(item.count),
                          tip: (
                            <>
                              <span className="font-medium">{item.name}</span>
                              <br />
                              {item.count} fanfic
                            </>
                          ),
                        }))}
                      />
                      <DataTable
                        columns={['Fandom', 'Fanfic']}
                        rows={fandoms.map((item) => [item.name, item.count])}
                      />
                    </>
                  )}
                </Card>

                <Card title="Lingue" note="Libri per lingua, edizioni comprese">
                  {languages.length === 0 ? (
                    <Empty>Nessun libro con la lingua indicata.</Empty>
                  ) : (
                    <>
                      <HBarChart
                        rows={languages.map((item) => ({
                          key: item.name,
                          name: languageName(item.name),
                          value: item.count,
                          valueLabel: String(item.count),
                          tip: (
                            <>
                              <span className="font-medium">{languageName(item.name)}</span>
                              <br />
                              {item.count} libri
                            </>
                          ),
                        }))}
                      />
                      <DataTable
                        columns={['Lingua', 'Libri']}
                        rows={languages.map((item) => [languageName(item.name), item.count])}
                      />
                    </>
                  )}
                </Card>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
