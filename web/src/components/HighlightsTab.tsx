import { useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { cn, formatDate } from '../utils';
import type { BookHighlight, BookMeta, HighlightColor } from '@shared/types';

interface Props {
  meta: BookMeta;
}

const COLOR_STYLES: Record<HighlightColor, { card: string; dot: string; label: string }> = {
  yellow: {
    card: 'border-amber-400/60 bg-amber-300/10',
    dot: 'bg-amber-400',
    label: 'Giallo',
  },
  pink: {
    card: 'border-rose-400/60 bg-rose-400/10',
    dot: 'bg-rose-400',
    label: 'Rosa',
  },
  green: {
    card: 'border-emerald-400/60 bg-emerald-400/10',
    dot: 'bg-emerald-400',
    label: 'Verde',
  },
  blue: {
    card: 'border-sky-400/60 bg-sky-400/10',
    dot: 'bg-sky-400',
    label: 'Blu',
  },
  purple: {
    card: 'border-violet-400/60 bg-violet-400/10',
    dot: 'bg-violet-400',
    label: 'Viola',
  },
  underline: {
    card: 'border-black/[0.12] bg-transparent',
    dot: 'bg-ink-400',
    label: 'Sottolineatura',
  },
  none: {
    card: 'border-black/[0.12] bg-transparent',
    dot: 'bg-ink-500',
    label: 'Senza colore',
  },
};

const SOURCE_LABEL: Record<BookHighlight['source'], string> = {
  applebooks: 'Apple Books',
  reader: 'Lettore',
  manual: 'Manuale',
};

/** Elimina una sottolineatura non di Apple Books, dopo conferma, e aggiorna il dettaglio. */
async function removeHighlight(meta: BookMeta, highlight: BookHighlight): Promise<void> {
  const store = useStore.getState();
  const answer = await store.confirm('Eliminare questa sottolineatura?', [
    { label: 'Elimina', value: 'delete', primary: true },
    { label: 'Annulla', value: 'cancel' },
  ]);
  if (answer !== 'delete') return;
  try {
    await api.deleteHighlight(meta.id, highlight.id);
    store.setHighlights(
      meta.id,
      (meta.highlights ?? []).filter((item) => item.id !== highlight.id),
    );
    store.toast('Sottolineatura eliminata', 'success');
  } catch (error) {
    store.toast((error as Error).message, 'error');
  }
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim() || 'libro';
}

function markdownFor(meta: BookMeta, highlights: BookHighlight[]): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title}`);
  if (meta.authors.length) lines.push(`*${meta.authors.join(', ')}*`);
  lines.push('', `## Sottolineature (${highlights.length})`, '');

  for (const highlight of highlights) {
    lines.push(`> ${highlight.text.split('\n').join('\n> ')}`, '');
    if (highlight.note) {
      lines.push(`**Nota:** ${highlight.note.replace(/\n/g, '  \n')}`, '');
    }
    const details = [highlight.chapter, formatDate(highlight.createdAt)].filter(
      (value) => value && value !== '—',
    );
    if (details.length) lines.push(`*${details.join(' · ')}*`, '');
    lines.push('---', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function copyText(text: string, success: string): void {
  if (!navigator.clipboard) {
    useStore.getState().toast('Appunti non disponibili in questo contesto', 'error');
    return;
  }
  void navigator.clipboard
    .writeText(text)
    .then(() => useStore.getState().toast(success, 'success'))
    .catch(() => useStore.getState().toast('Impossibile copiare negli appunti', 'error'));
}

export default function HighlightsTab({ meta }: Props) {
  const [query, setQuery] = useState('');
  const [onlyNotes, setOnlyNotes] = useState(false);
  const highlights = meta.highlights ?? [];

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return highlights.filter((highlight) => {
      if (onlyNotes && !highlight.note) return false;
      if (!needle) return true;
      return `${highlight.text} ${highlight.note} ${highlight.chapter}`
        .toLowerCase()
        .includes(needle);
    });
  }, [highlights, onlyNotes, query]);

  const withNotes = highlights.filter((highlight) => highlight.note).length;

  const exportMarkdown = () => {
    const blob = new Blob([markdownFor(meta, filtered)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(meta.title)} - sottolineature.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!highlights.length) {
    return (
      <div className="rounded-xl border border-dashed border-black/[0.12] bg-ink-800/60 p-6 text-center">
        <p className="text-sm font-medium text-ink-200">Nessuna sottolineatura</p>
        <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-ink-500">
          Seleziona del testo nel lettore per sottolinearlo. Le evidenziazioni e le note di
          Apple Books possono essere importate da Impostazioni → Sottolineature da Apple Books.
        </p>
        <button
          onClick={() => useStore.getState().setSettingsOpen(true)}
          className="btn-ghost mt-3 text-[12px]"
        >
          Apri impostazioni
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Cerca nelle sottolineature…"
            className="field-input py-1.5 text-[12px]"
          />
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-ink-400">
            <input
              type="checkbox"
              checked={onlyNotes}
              onChange={(event) => setOnlyNotes(event.target.checked)}
            />
            solo con note
          </label>
        </div>
        <button
          onClick={exportMarkdown}
          disabled={!filtered.length}
          className="btn-ghost text-[12px]"
          title="Scarica le sottolineature come file Markdown"
        >
          Esporta Markdown
        </button>
        <button
          onClick={() =>
            copyText(
              markdownFor(meta, filtered),
              `${filtered.length} sottolineature copiate`,
            )
          }
          disabled={!filtered.length}
          className="btn-ghost text-[12px]"
        >
          Copia
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
        <span>
          <strong className="text-ink-200">{highlights.length}</strong> sottolineature
          {filtered.length !== highlights.length ? ` · ${filtered.length} visibili` : ''}
        </span>
        {withNotes > 0 && (
          <span>
            <strong className="text-ink-200">{withNotes}</strong> con nota
          </span>
        )}
        <span className="text-ink-600">
          {[...new Set(highlights.map((item) => SOURCE_LABEL[item.source] ?? SOURCE_LABEL.manual))].join(' · ')}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-black/[0.06] bg-ink-800 p-4 text-center text-[12px] text-ink-500">
          Nessuna sottolineatura corrisponde alla ricerca.
        </p>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((highlight) => {
            const style = COLOR_STYLES[highlight.color] ?? COLOR_STYLES.none;
            return (
              <article
                key={highlight.id}
                className={cn('rounded-xl border-l-[3px] px-3 py-2.5', style.card)}
              >
                <blockquote className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-100">
                  {highlight.text}
                </blockquote>
                {highlight.note && (
                  <div className="mt-2 rounded-lg bg-black/[0.04] px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-300">
                    <span className="font-semibold text-ink-200">Nota: </span>
                    {highlight.note}
                  </div>
                )}
                <footer className="mt-2 flex flex-wrap items-center gap-2 text-[10.5px] text-ink-500">
                  <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', style.dot)}
                    title={style.label}
                  />
                  {highlight.chapter && <span>{highlight.chapter}</span>}
                  {highlight.createdAt && <span>{formatDate(highlight.createdAt)}</span>}
                  <span className="rounded bg-black/[0.05] px-1.5 py-0.5">
                    {SOURCE_LABEL[highlight.source] ?? SOURCE_LABEL.manual}
                  </span>
                  <span className="flex-1" />
                  {highlight.source === 'reader' && highlight.file && (
                    <button
                      onClick={() => useStore.getState().openReader(meta.id, highlight.file as string, highlight.location)}
                      className="min-h-[2.5rem] px-1 text-ink-500 underline decoration-ink-500/30 hover:text-ink-200 sm:min-h-0"
                    >
                      apri nel lettore
                    </button>
                  )}
                  {highlight.source !== 'applebooks' && (
                    <button
                      onClick={() => void removeHighlight(meta, highlight)}
                      className="min-h-[2.5rem] px-1 text-rose-600 underline decoration-rose-600/30 sm:min-h-0"
                    >
                      elimina
                    </button>
                  )}
                  <button
                    onClick={() =>
                      copyText(
                        [highlight.text, highlight.note ? `Nota: ${highlight.note}` : '']
                          .filter(Boolean)
                          .join('\n\n'),
                        'Sottolineatura copiata',
                      )
                    }
                    className="text-ink-500 underline decoration-ink-500/30 hover:text-ink-200"
                  >
                    copia
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
