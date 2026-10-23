import { useEffect, useState } from 'react';
import { api, withLibrary } from '../api';
import { useStore } from '../store';
import ReaderEpub from './ReaderEpub';
import ReaderPdf from './ReaderPdf';
import { READER_THEMES, ReaderMessage, readStoredTheme } from './ReaderParts';
import type { BookMeta } from '@shared/types';

/** Scarica il file con il cookie di sessione, riportando la percentuale se il server dichiara la lunghezza. */
async function fetchBookFile(
  id: string,
  file: string,
  onProgress: (percent: number | null) => void,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const url = withLibrary(`/api/books/${encodeURIComponent(id)}/download?file=${encodeURIComponent(file)}`);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Sessione scaduta: accedi di nuovo');
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Download non riuscito (errore ${response.status})`);
  }
  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress(total ? 0 : null);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(Math.min(100, (received / total) * 100));
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data.buffer;
}

type Loaded = { meta: BookMeta; data: ArrayBuffer };

/** Lettore integrato a tutto schermo: scarica il file e sceglie il lettore EPUB o PDF. */
export default function Reader({ id, file, location }: { id: string; file: string; location?: string }) {
  const closeReader = useStore((state) => state.closeReader);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const theme = READER_THEMES[readStoredTheme()];
  const isPdf = /\.pdf$/i.test(file);
  const readable = isPdf || /\.epub$/i.test(file);

  // Schermo bloccato sotto il lettore: niente scroll della pagina sottostante.
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    if (!readable) {
      setError('Questo formato non si puo\' leggere nel lettore integrato.');
      return;
    }
    const controller = new AbortController();
    setLoaded(null);
    setError('');
    setProgress(null);
    Promise.all([api.book(id), fetchBookFile(id, file, setProgress, controller.signal)])
      .then(([meta, data]) => setLoaded({ meta, data }))
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError((failure as Error).message || 'Impossibile scaricare il file');
      });
    return () => controller.abort();
  }, [id, file, readable]);

  let content;
  if (error) {
    content = <ReaderMessage theme={theme} title="Impossibile aprire il libro" detail={error} error onClose={closeReader} />;
  } else if (!loaded) {
    content = (
      <ReaderMessage
        theme={theme}
        title="Scarico il libro…"
        detail={progress !== null ? `${Math.round(progress)}%` : undefined}
        progress={progress}
        onClose={closeReader}
      />
    );
  } else if (isPdf) {
    content = <ReaderPdf meta={loaded.meta} file={file} data={loaded.data} onClose={closeReader} />;
  } else {
    content = <ReaderEpub meta={loaded.meta} file={file} data={loaded.data} startLocation={location} onClose={closeReader} />;
  }

  return (
    <div
      className="fixed inset-0 z-[70] overflow-hidden overscroll-none"
      style={{ background: theme.background }}
      role="dialog"
      aria-modal="true"
      aria-label="Lettore"
    >
      {content}
    </div>
  );
}
