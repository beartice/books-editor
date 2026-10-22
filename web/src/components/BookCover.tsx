import { useEffect, useRef, useState } from 'react';
import { withLibrary } from '../api';
import { cn, initials } from '../utils';
import { IconBook } from './icons';

interface Props {
  id: string;
  coverFile: string | null;
  title: string;
  authors?: string[];
  kind?: 'book' | 'fanfic';
  className?: string;
  rounded?: string;
  /** Cambia quando la copertina viene sostituita: invalida la cache del browser. */
  version?: string | null;
  /** small = 120 px, thumb = 480 px (miniature dal server), full = originale. */
  size?: 'small' | 'thumb' | 'full';
}

export default function BookCover({
  id,
  coverFile,
  title,
  authors = [],
  kind = 'book',
  className,
  rounded = 'rounded-lg',
  version,
  size = 'full',
}: Props) {
  const [failed, setFailed] = useState(false);
  // Un solo ritentativo (es. dopo un 429 del proxy), con parametro anti-cache.
  const [retried, setRetried] = useState(false);
  const retryTimer = useRef<number | undefined>(undefined);
  const showImage = coverFile && !failed;

  useEffect(() => {
    setFailed(false);
    setRetried(false);
    window.clearTimeout(retryTimer.current);
  }, [coverFile, version]);

  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  const handleError = () => {
    if (retried) {
      setFailed(true);
      return;
    }
    retryTimer.current = window.setTimeout(() => setRetried(true), 1500);
  };

  return (
    <div
      className={cn(
        'relative overflow-hidden bg-gradient-to-br from-ink-750 to-ink-700 ring-1 ring-inset ring-black/[0.06]',
        rounded,
        className,
      )}
    >
      {showImage ? (
        <img
          src={withLibrary(
            `/api/covers/${id}?v=${encodeURIComponent(coverFile!)}${
              version ? `&t=${encodeURIComponent(version)}` : ''
            }${size === 'small' ? '&w=120' : size === 'thumb' ? '&w=480' : ''}${
              retried ? '&r=1' : ''
            }`,
          )}
          alt={title}
          loading="lazy"
          onError={handleError}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          <IconBook className="h-6 w-6 text-ink-400" />
          <span className="line-clamp-3 text-[11px] font-semibold leading-tight text-ink-200">
            {title || 'Senza titolo'}
          </span>
          {authors[0] && (
            <span className="line-clamp-1 text-[10px] text-ink-500">{authors[0]}</span>
          )}
          {kind === 'fanfic' && (
            <span className="absolute right-1.5 top-1.5 rounded bg-coral-500/90 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
              ff
            </span>
          )}
        </div>
      )}
      {!showImage && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/10 to-transparent"
        />
      )}
    </div>
  );
}

export function CoverFallbackLetter({ name }: { name: string }) {
  return (
    <span className="flex h-full w-full items-center justify-center text-2xl font-bold text-ink-500">
      {initials(name)}
    </span>
  );
}
