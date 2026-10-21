import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useStore } from '../store';
import { cn, languageLabel } from '../utils';
import { IconTrash, IconUpload } from './icons';
import type { BookMeta, BookSummary } from '@shared/types';

/** Normalizza per la ricerca: minuscole, senza accenti. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Sezione «Lingue» della scheda: elenco delle edizioni, aggiunta di un file in
 * un'altra lingua e unione con un'altra scheda (la stessa opera in un'altra lingua).
 */
export default function LanguagesSection({ meta }: { meta: BookMeta }) {
  const { books, reloadBook, toast, confirm } = useStore();
  const [suggestions, setSuggestions] = useState<BookSummary[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const editions = meta.editions ?? [];

  // I suggerimenti si ricalcolano quando cambia la scheda o le sue lingue.
  useEffect(() => {
    let cancelled = false;
    api
      .editionSuggestions(meta.id)
      .then((list) => !cancelled && setSuggestions(list))
      .catch(() => !cancelled && setSuggestions([]));
    return () => {
      cancelled = true;
    };
  }, [meta.id, editions.length]);

  // Ricerca fra le altre schede, prima quelle dello stesso autore.
  const results = useMemo(() => {
    const needle = fold(query.trim());
    if (!searching || !needle) return [];
    const author = fold(meta.authors[0] ?? '');
    return books
      .filter((book) => book.id !== meta.id)
      .filter((book) => fold(`${book.title} ${book.authors.join(' ')}`).includes(needle))
      .sort((a, b) => {
        const sameA = author && fold(a.authors[0] ?? '') === author ? 0 : 1;
        const sameB = author && fold(b.authors[0] ?? '') === author ? 0 : 1;
        return sameA - sameB || a.title.localeCompare(b.title, 'it');
      })
      .slice(0, 8);
  }, [books, meta.id, meta.authors, query, searching]);

  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    try {
      await action();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setWorking(false);
    }
  };

  const addLanguage = (file: File) =>
    run(async () => {
      try {
        const updated = await api.addEdition(meta.id, file);
        const added = updated.editions?.[updated.editions.length - 1];
        await reloadBook(meta.id);
        toast(`Aggiunta la lingua: ${languageLabel(added?.language)}`, 'success');
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          toast((error as Error).message, 'error');
          return;
        }
        throw error;
      }
    });

  const remove = (file: string) => {
    if (armed !== file) {
      setArmed(file);
      setTimeout(() => setArmed((current) => (current === file ? null : current)), 4000);
      return;
    }
    setArmed(null);
    void run(async () => {
      await api.removeEdition(meta.id, file);
      await reloadBook(meta.id);
      toast('Edizione rimossa (il file è in .backup)', 'success');
    });
  };

  const mergeWith = async (other: { id: string; title: string }) => {
    const answer = await confirm(
      `«${other.title}» verrà unita a questa scheda come altra lingua. Continuare?`,
      [
        { label: 'Unisci', value: 'merge', primary: true },
        { label: 'Annulla', value: 'cancel' },
      ],
    );
    if (answer !== 'merge') return;
    await run(async () => {
      const result = await api.mergeBook(meta.id, other.id);
      setSearching(false);
      setQuery('');
      await reloadBook(meta.id);
      toast(result.note ? `Schede unite. ${result.note}` : 'Schede unite', 'success');
    });
  };

  const rows = [
    { file: meta.sourceFile ?? '', language: meta.language, title: meta.title, main: true },
    ...editions.map((edition) => ({ ...edition, main: false })),
  ].filter((row) => row.file);

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        Lingue
      </h3>
      <div className="space-y-2 rounded-xl border border-black/[0.06] bg-ink-800 p-3 text-[12px]">
        {rows.map((row) => (
          <div key={row.file} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-ink-100">
                <span className="font-medium">{languageLabel(row.language)}</span>
                {row.main && <span className="ml-1.5 text-[11px] text-ink-500">principale</span>}
                {' · '}
                {row.title || 'Senza titolo'}
              </p>
              <p className="truncate text-[11px] text-ink-500">{row.file}</p>
            </div>
            {!row.main && (
              <button
                onClick={() => remove(row.file)}
                disabled={working}
                className={cn(
                  'btn-subtle shrink-0 px-2 py-0.5 text-[11px] disabled:opacity-60',
                  armed === row.file && 'text-rose-600',
                )}
                title="Il file viene spostato in .backup, non cancellato"
              >
                <IconTrash className="h-3.5 w-3.5" />
                {armed === row.file ? 'Conferma: rimuovi' : 'Rimuovi'}
              </button>
            )}
          </div>
        ))}

        <div className="flex flex-wrap gap-1.5 pt-1">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={working || !meta.sourceFile}
            className="btn-ghost px-2.5 py-1 text-[12px] disabled:opacity-60"
          >
            <IconUpload className={cn('h-3.5 w-3.5', working && 'animate-pulse')} />
            Aggiungi lingua…
          </button>
          <button
            onClick={() => setSearching((value) => !value)}
            disabled={working}
            className="btn-ghost px-2.5 py-1 text-[12px] disabled:opacity-60"
          >
            Unisci con…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".epub,.pdf,.docx,.txt,.md,.rtf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void addLanguage(file);
            }}
          />
        </div>

        {searching && (
          <div className="space-y-1">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Cerca la scheda da unire (titolo o autore)"
              className="field-input"
            />
            {results.map((book) => (
              <button
                key={book.id}
                onClick={() => void mergeWith(book)}
                disabled={working}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-ink-200 hover:bg-black/[0.04]"
              >
                <span className="min-w-0 flex-1 truncate">
                  {book.title}
                  <span className="text-ink-500"> · {book.authors.join(', ') || 'Autore sconosciuto'}</span>
                </span>
                {book.language && (
                  <span className="shrink-0 text-[11px] text-ink-500">{languageLabel(book.language)}</span>
                )}
              </button>
            ))}
            {query.trim() && results.length === 0 && (
              <p className="px-2 text-[11px] text-ink-500">Nessuna scheda trovata.</p>
            )}
          </div>
        )}

        {suggestions.map((book) => (
          <div key={book.id} className="flex items-center gap-2 border-t border-black/[0.06] pt-2">
            <p className="min-w-0 flex-1 truncate text-ink-300">
              Possibile stessa opera in altra lingua: «{book.title}» ({languageLabel(book.language)})
            </p>
            <button
              onClick={() => void mergeWith(book)}
              disabled={working}
              className="btn-ghost shrink-0 px-2.5 py-0.5 text-[11px] disabled:opacity-60"
            >
              Unisci
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
