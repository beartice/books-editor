import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { cn } from '../utils';
import { IconPlus } from './icons';

interface Props {
  /** Chiude il pannello (su mobile la sidebar e' il pannello «Filtri»). */
  onClose: () => void;
}

/** Elenco delle librerie dell'account: apri, crea, rinomina, elimina. */
export default function LibrariesSection({ onClose }: Props) {
  const { libraries, libraryId, setLibrary, loadLibraries, confirm, toast } = useStore();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating || renamingId) inputRef.current?.focus();
  }, [creating, renamingId]);

  const stopEditing = () => {
    setCreating(false);
    setRenamingId(null);
    setDraft('');
  };

  const open = async (id: string) => {
    onClose();
    if (id !== libraryId) await setLibrary(id);
  };

  const submit = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      if (renamingId) {
        await api.renameLibrary(renamingId, name);
        await loadLibraries();
        // Il titolo mostrato altrove viene dalle impostazioni della libreria aperta.
        if (renamingId === libraryId) {
          useStore.setState({ settings: await api.settings() });
        }
        stopEditing();
      } else {
        const created = await api.createLibrary(name);
        stopEditing();
        onClose();
        await setLibrary(created.id);
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, name: string) => {
    setMenuId(null);
    const answer = await confirm(`Eliminare la libreria «${name}»? È vuota: verrà tolta solo la sua cartella.`, [
      { label: 'Elimina', value: 'delete', primary: true },
      { label: 'Annulla', value: 'cancel' },
    ]);
    if (answer !== 'delete') return;
    try {
      await api.deleteLibrary(id);
      toast(`Libreria «${name}» eliminata`, 'success');
      if (id === libraryId) await setLibrary('main');
      else await loadLibraries();
    } catch (error) {
      toast((error as Error).message, 'error');
      await loadLibraries();
    }
  };

  const editor = (
    <input
      ref={inputRef}
      value={draft}
      maxLength={80}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void submit();
        if (event.key === 'Escape') stopEditing();
      }}
      onBlur={() => {
        // Toccare fuori annulla, ma non mentre la richiesta e' in corso.
        if (!busy) stopEditing();
      }}
      enterKeyHint="done"
      placeholder={renamingId ? 'Nuovo nome' : 'Nome della libreria'}
      aria-label={renamingId ? 'Nuovo nome della libreria' : 'Nome della nuova libreria'}
      className="field-input min-h-10 py-1.5"
    />
  );

  return (
    <div className="mb-5">
      <p className="px-2.5 text-[9px] font-semibold uppercase tracking-[0.2em] text-ink-500">Librerie</p>
      <ul className="mt-2 space-y-0.5">
        {libraries.map((library) => {
          const active = library.id === libraryId;
          if (renamingId === library.id) {
            return (
              <li key={library.id} className="px-1">
                {editor}
              </li>
            );
          }
          const emptyLibrary = library.bookCount === 0;
          return (
            <li key={library.id}>
              <div
                className={cn(
                  'flex items-center rounded-lg transition',
                  active ? 'bg-accent-500/10' : 'hover:bg-black/[0.035]',
                )}
              >
                <button
                  onClick={() => void open(library.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] lg:min-h-8',
                    active ? 'font-medium text-accent-700' : 'text-ink-400 hover:text-ink-100',
                  )}
                >
                  <span className="truncate">{library.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-500">
                    {library.bookCount}
                  </span>
                </button>
                <button
                  onClick={() => setMenuId(menuId === library.id ? null : library.id)}
                  aria-label={`Azioni per la libreria ${library.name}`}
                  aria-expanded={menuId === library.id}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[16px] leading-none text-ink-500 transition hover:text-ink-100 lg:h-8 lg:w-8"
                >
                  ⋯
                </button>
              </div>
              {menuId === library.id && (
                <div className="mb-1 ml-2 mt-0.5 flex flex-col rounded-lg border border-black/[0.06] bg-white p-1">
                  <button
                    onClick={() => {
                      setMenuId(null);
                      setCreating(false);
                      setDraft(library.name);
                      setRenamingId(library.id);
                    }}
                    className="min-h-10 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink-200 hover:bg-black/[0.05] lg:min-h-8"
                  >
                    Rinomina
                  </button>
                  {!library.isMain && (
                    <button
                      onClick={() => {
                        if (emptyLibrary) void remove(library.id, library.name);
                      }}
                      aria-disabled={!emptyLibrary}
                      title={
                        emptyLibrary
                          ? undefined
                          : 'La libreria contiene ancora delle opere: spostale o eliminale prima'
                      }
                      className="min-h-10 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-rose-600 hover:bg-rose-500/10 aria-disabled:cursor-not-allowed aria-disabled:text-ink-500 aria-disabled:hover:bg-transparent lg:min-h-8"
                    >
                      Elimina
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {creating ? (
        <div className="mt-1 px-1">{editor}</div>
      ) : (
        <button
          onClick={() => {
            setRenamingId(null);
            setDraft('');
            setCreating(true);
          }}
          className="mt-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] font-medium text-ink-400 transition hover:bg-black/[0.035] hover:text-ink-100 lg:min-h-8"
        >
          <IconPlus className="h-3.5 w-3.5" />
          Nuova libreria
        </button>
      )}
    </div>
  );
}
