import { useMemo, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useStore } from '../store';
import { unmappedTags } from '../genres';
import { computeGenreStats, computeLanguages, computeTopFandoms, formatRating, ratedGenres } from '../stats';
import { EmptyNote } from './StatsParts';

// Sezione «Altro» del Cruscotto: le statistiche della vecchia finestra che non entrano nelle
// tre viste (voto medio per genere, fandom, lingue). Riguardano tutta la libreria, non il periodo.

const BAR_MAX = 24;

function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['it'], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Codice non riconosciuto: si mostra com'e'.
  }
  return code;
}

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

interface BarRow {
  key: string;
  name: string;
  value: number;
  /** Testo alla punta della barra. */
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
            className="flex min-h-10 items-center gap-2 rounded-md px-1 hover:bg-ink-800 sm:h-6 sm:min-h-0"
            onMouseMove={(event) => show(event, row.tip)}
          >
            <span className="w-28 shrink-0 truncate text-right text-[11.5px] text-ink-300 sm:w-36">{row.name}</span>
            <div className="flex min-w-0 flex-1 items-center">
              <div
                className="rounded-r-[4px] bg-accent-500"
                style={{
                  height: Math.min(BAR_MAX, 16),
                  width: `max(2px, calc((100% - 7.5rem) * ${fraction}))`,
                }}
              />
              <span className="ml-2 whitespace-nowrap text-[11px] tabular-nums text-ink-200">{row.valueLabel}</span>
            </div>
          </div>
        );
      })}
      <ChartTooltip tip={tip} width={ref.current?.clientWidth ?? 320} />
    </div>
  );
}

function OtherCard({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="rounded-[18px] border border-[#ebe5d9] p-4 sm:p-[18px]">
      <h3 className="text-[14.5px] font-semibold text-ink-100">{title}</h3>
      <p className="mt-0.5 text-xs text-[#6b655a]">{note}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function StatsOther({ hasFanfics }: { hasFanfics: boolean }) {
  const books = useStore((state) => state.books);
  const allGenres = useMemo(() => computeGenreStats(books), [books]);
  const ratedByGenre = useMemo(() => ratedGenres(allGenres), [allGenres]);
  const fandoms = useMemo(() => computeTopFandoms(books), [books]);
  const languages = useMemo(() => computeLanguages(books), [books]);
  const unmapped = useMemo(() => unmappedTags(books, 12), [books]);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[17px] font-semibold text-ink-100">Altro</h2>
        <p className="mt-0.5 text-xs text-[#6b655a]">Su tutta la libreria, senza il filtro del periodo.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <OtherCard title="Voto medio per genere" note="Solo generi con almeno 3 libri votati">
          {ratedByGenre.length === 0 ? (
            <EmptyNote>Nessun genere ha ancora 3 libri votati.</EmptyNote>
          ) : (
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
          )}
          {unmapped.length > 0 && (
            <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
              Tag non classificati più frequenti: {unmapped.map((item) => `${item.tag} (${item.count})`).join(', ')}
            </p>
          )}
        </OtherCard>

        {hasFanfics && (
          <OtherCard title="Fandom più presenti" note="Fanfic per fandom, primi 10">
            {fandoms.length === 0 ? (
              <EmptyNote>Nessuna fanfic con fandom nella libreria.</EmptyNote>
            ) : (
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
            )}
          </OtherCard>
        )}

        <OtherCard title="Lingue" note="Libri per lingua, edizioni comprese">
          {languages.length === 0 ? (
            <EmptyNote>Nessun libro con la lingua indicata.</EmptyNote>
          ) : (
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
          )}
        </OtherCard>
      </div>
    </section>
  );
}
