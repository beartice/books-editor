import { isFanficUpdateAvailable } from '@shared/types';
import type { BookSummary, FanficUpdate, ReadingStatus, SortKey } from '@shared/types';

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/** Etichetta della card per un aggiornamento da segnalare: «+2 cap.» o «Completata»; null se non c'e'. */
export function fanficUpdateLabel(update: FanficUpdate | null | undefined): string | null {
  if (!isFanficUpdateAvailable(update) || !update) return null;
  return update.newChapters > 0 ? `+${update.newChapters} cap.` : 'Completata';
}

export function formatWords(count: number | null | undefined): string {
  if (!count) return '—';
  if (count < 1000) return `${count} parole`;
  return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k parole`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('it-IT').format(value);
}

export function formatDuration(words: number | null, wordsPerMinute = 230): string {
  if (!words) return '—';
  const minutes = Math.round(words / wordsPerMinute);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('it-IT', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relativeDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) return 'oggi';
  if (days === 1) return 'ieri';
  if (days < 30) return `${days} giorni fa`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mesi fa`;
  return `${Math.floor(months / 12)} anni fa`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Lunghezza normalizzata: parole, con fallback sulle pagine. */
export function lengthOf(book: BookSummary): number {
  if (book.wordCount) return book.wordCount;
  if (book.pageCount) return book.pageCount * 250;
  return 0;
}

export const SORT_LABELS: Record<SortKey, string> = {
  title: 'Titolo',
  author: 'Autore',
  series: 'Serie',
  length: 'Lunghezza',
  dateAdded: 'Aggiunto',
  dateModified: 'Modificato',
  publishedDate: 'Pubblicazione',
  rating: 'Voto',
  fandom: 'Fandom',
  lastRead: 'Ultima lettura',
  dateFinished: 'Finito il',
  readingProgress: 'Avanzamento',
};

export const READING_STATUS_LABEL: Record<ReadingStatus, string> = {
  unread: 'Da leggere',
  reading: 'In lettura',
  read: 'Letto',
  reread: 'Rilettura',
  dnf: 'DNF',
};

/** Voto a mezze stelle in formato italiano: 3,5. */
export function formatRating(value: number): string {
  return value.toLocaleString('it-IT', { maximumFractionDigits: 1 });
}

export const COVER_PLACEHOLDERS = ['#3b2f63', '#2b3a5e', '#4a2b45', '#2f4a44', '#4a3a24'];

/** Fa salvare al browser un file ricevuto dal server. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let languageNames: Intl.DisplayNames | null = null;

/** Nome italiano di una lingua («Italiano», «Inglese») da un codice ISO 639-1. */
export function languageLabel(code: string | null | undefined): string {
  const value = (code ?? '').trim().toLowerCase();
  if (!value) return 'Lingua sconosciuta';
  try {
    languageNames ??= new Intl.DisplayNames(['it'], { type: 'language' });
    const name = languageNames.of(value);
    if (name && name !== value) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    // Codice non valido o Intl.DisplayNames non disponibile: si mostra il codice.
  }
  return value.toUpperCase();
}

/**
 * Chiave confrontabile (AAAA-MM-GG) per una data di uscita scritta in formati diversi:
 * «2016-07-25», «2015-09», «2022», «Nov 03, 2014», «March 24 2026». Le date
 * mancanti o illeggibili vanno in fondo.
 */
export function releaseDateKey(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '￿';
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(text);
  if (iso) {
    const [, year, month = '00', day = '00'] = iso;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    // Date.parse legge «Nov 03, 2014» nell'ora locale: niente toISOString (UTC), che sposterebbe il giorno.
    const date = new Date(parsed);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  const year = /\b(\d{4})\b/.exec(text);
  return year ? `${year[1]}-00-00` : '￿';
}
