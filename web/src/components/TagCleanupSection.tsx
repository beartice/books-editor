import { useMemo, useState } from 'react';
import type { TagCleanupGroup, TagCleanupPlan } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

const NAME_MAX = 100;

/**
 * Pulizia dei tag dei libri: anteprima di cio' che si unisce e di cio' che si toglie, con
 * la scelta dei singoli gruppi. Le fanfic non sono coinvolte. L'ultima pulizia si annulla.
 */
export default function TagCleanupSection() {
  const refreshBooks = useStore((state) => state.refreshBooks);
  const toast = useStore((state) => state.toast);
  const confirm = useStore((state) => state.confirm);
  const [plan, setPlan] = useState<TagCleanupPlan | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async (keepOpen = false) => {
    setBusy(true);
    setError('');
    try {
      const next = await api.tagCleanupPlan();
      setPlan(next);
      if (!keepOpen || !plan) {
        setSelected(Object.fromEntries(next.groups.map((group) => [group.id, group.defaultSelected])));
        setNames(Object.fromEntries(next.groups.filter((g) => g.kind === 'merge').map((g) => [g.id, g.canonical])));
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const merges = plan?.groups.filter((group) => group.kind === 'merge') ?? [];
  const removes = plan?.groups.filter((group) => group.kind === 'remove') ?? [];
  const chosen = useMemo(() => (plan?.groups ?? []).filter((group) => selected[group.id]), [plan, selected]);
  const books = useMemo(() => new Set(chosen.flatMap((group) => group.bookIds)).size, [chosen]);
  const nameProblem = chosen.some(
    (group) => group.kind === 'merge' && (!names[group.id]?.trim() || names[group.id].trim().length > NAME_MAX),
  );

  const setAll = (value: boolean) =>
    setSelected(Object.fromEntries((plan?.groups ?? []).map((group) => [group.id, value])));

  const apply = async () => {
    if (!chosen.length || nameProblem) return;
    const answer = await confirm(
      `Cambiare i tag di ${books} ${books === 1 ? 'libro' : 'libri'}? Si può annullare con «Annulla l'ultima pulizia».`,
      [
        { label: 'Applica', value: 'apply', primary: true },
        { label: 'Annulla', value: 'cancel' },
      ],
    );
    if (answer !== 'apply') return;
    setBusy(true);
    try {
      const result = await api.applyTagCleanup(
        chosen.map((group) =>
          group.kind === 'merge' ? { id: group.id, canonical: names[group.id].trim() } : { id: group.id },
        ),
      );
      toast(`Tag puliti in ${result.books} ${result.books === 1 ? 'libro' : 'libri'}`, 'success');
      await refreshBooks();
      setPlan(null);
      await load();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  const undo = async () => {
    const last = plan?.lastCleanup;
    if (!last || last.undone) return;
    const answer = await confirm(
      `Annullare l'ultima pulizia (${last.books} ${last.books === 1 ? 'libro' : 'libri'}, ${formatDateTime(last.at)})? I libri con tag modificati dopo non vengono toccati.`,
      [
        { label: 'Annulla la pulizia', value: 'undo', primary: true },
        { label: 'Indietro', value: 'cancel' },
      ],
    );
    if (answer !== 'undo') return;
    setBusy(true);
    try {
      const result = await api.undoTagCleanup();
      toast(
        result.skipped
          ? `Tag ripristinati in ${result.restored} libri; ${result.skipped} saltati perché modificati nel frattempo`
          : `Tag ripristinati in ${result.restored} ${result.restored === 1 ? 'libro' : 'libri'}`,
        'success',
      );
      await refreshBooks();
      await load();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  const renderGroup = (group: TagCleanupGroup) => (
    <li key={group.id} className="rounded-lg border border-black/[0.06] bg-white p-2">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={Boolean(selected[group.id])}
          onChange={(event) => setSelected((previous) => ({ ...previous, [group.id]: event.target.checked }))}
          className="mt-1 h-4 w-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          {group.kind === 'merge' ? (
            <span className="block text-[11px] text-ink-500">Nome finale</span>
          ) : (
            <span className="block break-words text-[12px] font-medium text-ink-200">{group.label}</span>
          )}
          <span className="block text-[11px] text-ink-500">
            {group.bookIds.length} {group.bookIds.length === 1 ? 'libro' : 'libri'}
          </span>
        </span>
      </label>
      {group.kind === 'merge' && (
        <input
          value={names[group.id] ?? ''}
          maxLength={NAME_MAX}
          onChange={(event) => setNames((previous) => ({ ...previous, [group.id]: event.target.value }))}
          aria-label={`Nome finale di ${group.canonical}`}
          className="field-input mt-1 w-full text-[12px]"
        />
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {group.variants.map((variant) => (
          <span key={variant.tag} className="chip max-w-full break-all">
            {variant.tag} <span className="tabular-nums text-ink-500">×{variant.count}</span>
          </span>
        ))}
      </div>
    </li>
  );

  const last = plan?.lastCleanup;
  return (
    <div className="rounded-lg border border-black/[0.06] bg-ink-800 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="field-label !mb-0">Pulizia dei tag</span>
        <span className="chip border-black/[0.08] text-ink-400">solo libri</span>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-500">
        Unisce i tag scritti in modi diversi e toglie quelli che non descrivono il libro. Riguarda solo i libri, non le fanfic.
        Le scelte valgono con «Applica» in fondo all'elenco, non con «Salva».
      </p>
      <button
        type="button"
        onClick={() => void load()}
        disabled={busy}
        className="btn-ghost mt-2 text-[12px] disabled:opacity-60"
      >
        {busy && !plan ? 'Analizzo…' : plan ? 'Analizza di nuovo' : 'Analizza'}
      </button>
      {error && <p className="mt-2 break-words text-[11px] leading-relaxed text-rose-600">{error}</p>}

      {last && !last.undone && (
        <button
          type="button"
          onClick={() => void undo()}
          disabled={busy}
          className="btn-ghost mt-2 block text-left text-[12px] disabled:opacity-60"
        >
          Annulla l'ultima pulizia ({last.books} {last.books === 1 ? 'libro' : 'libri'}, {formatDateTime(last.at)})
        </button>
      )}

      {plan && (
        <div className="mt-3">
          {plan.groups.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-ink-400">I tag dei libri sono già in ordine.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <button type="button" onClick={() => setAll(true)} className="btn-subtle min-h-9 px-2">
                  Seleziona tutto
                </button>
                <button type="button" onClick={() => setAll(false)} className="btn-subtle min-h-9 px-2">
                  Nessuno
                </button>
                <span className="text-ink-300">
                  {books} {books === 1 ? 'libro cambierà' : 'libri cambieranno'}
                </span>
              </div>

              {merges.length > 0 && (
                <>
                  <h4 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                    Da unire ({merges.length})
                  </h4>
                  <ul className="flex flex-col gap-2">{merges.map(renderGroup)}</ul>
                </>
              )}
              {removes.length > 0 && (
                <>
                  <h4 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-500">
                    Da togliere ({removes.length})
                  </h4>
                  <ul className="flex flex-col gap-2">{removes.map(renderGroup)}</ul>
                </>
              )}

              <button
                type="button"
                onClick={() => void apply()}
                disabled={busy || !chosen.length || nameProblem}
                className="btn-primary mt-3 text-[12px] disabled:opacity-60"
              >
                Applica
              </button>
              {nameProblem && (
                <p className="mt-1 text-[11px] text-rose-600">
                  Ogni nome finale deve avere da 1 a {NAME_MAX} caratteri.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
