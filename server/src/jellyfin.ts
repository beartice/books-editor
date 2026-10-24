import { loadSettings } from './store.js';

/*
 * Client minimo dell'API di Jellyfin: connessione, librerie ed elenco dei libri.
 * L'abbinamento con le schede e l'invio dei metadati stanno in jellyfinSync.ts.
 */

const API_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 200;

/** Errore con messaggio leggibile, pensato per essere mostrato all'utente. */
export class JellyfinError extends Error {}

/** Jellyfin non risponde o rifiuta la chiave: inutile insistere con le richieste successive. */
export class JellyfinConnectionError extends JellyfinError {}

export interface JellyfinInfo {
  serverName: string;
  version: string;
}

export interface JellyfinLibrary {
  id: string;
  name: string;
  type: string;
}

/** Elemento restituito da `GET /Items` (solo i campi che servono). */
export interface JellyfinItem {
  Id: string;
  Name?: string;
  Path?: string;
}

async function credentials(): Promise<{ url: string; key: string }> {
  const settings = await loadSettings();
  const url = (settings.jellyfinUrl ?? '').trim().replace(/\/+$/, '');
  const key = (settings.jellyfinApiKey ?? '').trim();
  if (!url) throw new JellyfinError('Indirizzo Jellyfin mancante: impostalo nelle Impostazioni');
  if (!key) throw new JellyfinError('Chiave API Jellyfin mancante: impostala nelle Impostazioni');
  return { url, key };
}

export interface JellyfinRequestOptions {
  timeoutMs?: number;
  /** Solo lettura e scrittura: il client non cancella mai nulla su Jellyfin. */
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
}

/** Richiesta a Jellyfin con chiave API, timeout ed errori in italiano. */
export async function jellyfinFetch(
  pathAndQuery: string,
  options: JellyfinRequestOptions = {},
): Promise<Response> {
  const { url, key } = await credentials();
  let response: Response;
  try {
    response = await fetch(`${url}${pathAndQuery}`, {
      method: options.method ?? 'GET',
      // Jellyfin 10.11+ ha disattivato i metodi legacy (X-Emby-Token, ?api_key=):
      // l'header Authorization funziona su tutte le versioni.
      headers: {
        Authorization: `MediaBrowser Token="${key}"`,
        Accept: 'application/json',
        ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      },
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new JellyfinConnectionError('Jellyfin non ha risposto in tempo');
    }
    throw new JellyfinConnectionError(`Server Jellyfin non raggiungibile (${url})`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new JellyfinConnectionError('Chiave API Jellyfin non valida o senza permessi');
  }
  return response;
}

export async function jellyfinJson<T>(pathAndQuery: string): Promise<T> {
  const response = await jellyfinFetch(pathAndQuery);
  if (!response.ok) throw new JellyfinError(`Jellyfin ha risposto con errore ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new JellyfinError('Risposta di Jellyfin non valida (l\'indirizzo e\' corretto?)');
  }
}

export async function getJellyfinInfo(): Promise<JellyfinInfo> {
  // L'endpoint pubblico non verifica la chiave: la si prova subito dopo con le librerie.
  const info = await jellyfinJson<{ ServerName?: string; Version?: string }>('/System/Info/Public');
  await jellyfinJson('/Library/VirtualFolders');
  return { serverName: info.ServerName ?? 'Jellyfin', version: info.Version ?? '' };
}

export async function listJellyfinLibraries(): Promise<JellyfinLibrary[]> {
  const folders = await jellyfinJson<
    Array<{ Name?: string; ItemId?: string; CollectionType?: string }>
  >('/Library/VirtualFolders');
  const libraries = folders
    .filter((folder) => folder.ItemId)
    .map((folder) => ({
      id: folder.ItemId as string,
      name: folder.Name ?? folder.ItemId as string,
      type: folder.CollectionType ?? '',
    }));
  // Prima le librerie di libri e, fra queste, quella chiamata "Books"/"Libri":
  // Jellyfin usa il tipo "books" anche per manga, fumetti e riviste.
  const rank = (library: JellyfinLibrary): number =>
    library.type !== 'books' ? 2 : /^(books?|libri|ebooks?)$/i.test(library.name.trim()) ? 0 : 1;
  return [...libraries].sort((left, right) => rank(left) - rank(right));
}

let adminId: { url: string; id: string } | null = null;

/** Utente amministratore: `GET /Items/{id}` con una chiave API vuole uno `userId` esplicito. */
export async function adminUserId(): Promise<string> {
  const { url } = await credentials();
  if (adminId?.url === url) return adminId.id;
  const users = await jellyfinJson<Array<{ Id: string; Policy?: { IsAdministrator?: boolean } }>>(
    '/Users',
  );
  const user = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
  if (!user) throw new JellyfinError('Nessun utente trovato su Jellyfin');
  adminId = { url, id: user.Id };
  return user.Id;
}

/** Tutti i libri di una libreria, paginando. */
export async function listJellyfinBooks(libraryId: string): Promise<JellyfinItem[]> {
  const items: JellyfinItem[] = [];
  let userId: string | null = null;
  let start = 0;
  for (;;) {
    const query =
      `ParentId=${encodeURIComponent(libraryId)}&Recursive=true&IncludeItemTypes=Book` +
      `&Fields=Path&StartIndex=${start}&Limit=${PAGE_SIZE}`;
    let response = await jellyfinFetch(userId ? `/Users/${userId}/Items?${query}` : `/Items?${query}`);
    // Alcune versioni rispondono 400 senza utente: si ripete come utente.
    if (response.status === 400 && !userId) {
      userId = await adminUserId();
      response = await jellyfinFetch(`/Users/${userId}/Items?${query}`);
    }
    if (!response.ok) throw new JellyfinError(`Jellyfin ha risposto con errore ${response.status}`);
    const page = (await response.json()) as { Items?: JellyfinItem[]; TotalRecordCount?: number };
    const batch = page.Items ?? [];
    items.push(...batch);
    start += batch.length;
    if (!batch.length || start >= (page.TotalRecordCount ?? 0)) break;
  }
  return items;
}
