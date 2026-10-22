import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';

/** «Sposta in…»: menu delle altre librerie. Compare solo se ce n'e' piu' di una. */
export default function MoveBookMenu() {
  const { libraries, libraryId, moveBook, busy } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const others = libraries.filter((library) => library.id !== libraryId);

  // Si chiude toccando fuori dal menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  if (libraries.length < 2 || others.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        aria-expanded={open}
        className="btn-ghost"
        title="Sposta il libro in un'altra libreria (non viene copiato)"
      >
        Sposta in… ▾
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 sm:left-auto sm:right-0 mb-1 min-w-[14rem] max-w-[20rem] rounded-lg border border-black/[0.08] bg-white p-1 shadow-panel">
          {others.map((library) => (
            <button
              key={library.id}
              onClick={() => {
                setOpen(false);
                void moveBook(library.id);
              }}
              className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink-200 hover:bg-black/[0.05] sm:min-h-8"
            >
              <span className="truncate">{library.name}</span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-500">{library.bookCount}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
