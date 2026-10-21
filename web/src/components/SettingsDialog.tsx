import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useStore } from '../store';
import { ApiError, api } from '../api';
import type { AppleBooksImportResult } from '@shared/types';
import { IconClose, IconFolder, IconLogout } from './icons';

interface Props {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: Props) {
  const { settings, setSettings } = useStore();
  const [libraryRoot, setLibraryRoot] = useState(settings?.libraryRoot ?? '');
  const [libraryName, setLibraryName] = useState(settings?.libraryName ?? '');
  const [searchLanguage, setSearchLanguage] = useState(settings?.searchLanguage ?? 'it');
  const [providers, setProviders] = useState<string[]>(settings?.providers ?? []);
  const [autoLookup, setAutoLookup] = useState(settings?.autoLookup ?? false);
  const [wordsPerHour, setWordsPerHour] = useState(settings?.wordsPerHour ?? 230);
  const [seriesRefreshDays, setSeriesRefreshDays] = useState(
    settings?.seriesRefreshDays ?? 30,
  );
  const [googleBooksApiKey, setGoogleBooksApiKey] = useState('');
  const [removeGoogleBooksKey, setRemoveGoogleBooksKey] = useState(false);
  const [jellyfinUrl, setJellyfinUrl] = useState(settings?.jellyfinUrl ?? '');
  const [jellyfinApiKey, setJellyfinApiKey] = useState('');
  const [removeJellyfinKey, setRemoveJellyfinKey] = useState(false);
  const [jellyfinBusy, setJellyfinBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [appleResult, setAppleResult] = useState<AppleBooksImportResult | null>(null);
  const [appleError, setAppleError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings) {
      setLibraryRoot(settings.libraryRoot);
      setLibraryName(settings.libraryName);
      setSearchLanguage(settings.searchLanguage);
      setProviders(settings.providers);
      setAutoLookup(settings.autoLookup);
      setWordsPerHour(settings.wordsPerHour);
      setSeriesRefreshDays(settings.seriesRefreshDays ?? 30);
      setGoogleBooksApiKey('');
      setRemoveGoogleBooksKey(false);
      setJellyfinUrl(settings.jellyfinUrl ?? '');
      setJellyfinApiKey('');
      setRemoveJellyfinKey(false);
    }
  }, [settings]);

  if (!settings) return null;

  /** Patch con indirizzo e chiave Jellyfin (la chiave solo se cambiata o rimossa). */
  const jellyfinPatch = () => {
    const trimmedKey = jellyfinApiKey.trim();
    return {
      jellyfinUrl: jellyfinUrl.trim(),
      ...(trimmedKey
        ? { jellyfinApiKey: trimmedKey }
        : removeJellyfinKey
          ? { jellyfinApiKey: '' }
          : {}),
    };
  };

  /** Salva indirizzo e chiave, poi interroga il server Jellyfin. */
  const verifyJellyfin = async () => {
    const toast = useStore.getState().toast;
    setJellyfinBusy(true);
    try {
      const saved = await api.updateSettings(jellyfinPatch());
      useStore.setState({ settings: saved });
      const info = await api.jellyfinInfo();
      toast(`Connesso a ${info.serverName} (Jellyfin ${info.version})`, 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setJellyfinBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    const rootChanged = !settings.libraryRootLocked && libraryRoot !== settings.libraryRoot;
    const trimmedKey = googleBooksApiKey.trim();
    const keyPatch = trimmedKey
      ? { googleBooksApiKey: trimmedKey }
      : removeGoogleBooksKey
        ? { googleBooksApiKey: '' }
        : {};
    await setSettings({
      ...(settings.libraryRootLocked ? {} : { libraryRoot }),
      libraryName,
      searchLanguage,
      providers,
      autoLookup,
      wordsPerHour,
      seriesRefreshDays: Math.min(365, Math.max(1, Math.round(seriesRefreshDays || 30))),
      ...keyPatch,
      ...jellyfinPatch(),
    });
    if (rootChanged) await useStore.getState().scan();
    setBusy(false);
  };

  const importApple = async () => {
    setAppleBusy(true);
    setAppleError('');
    setAppleResult(null);
    try {
      const result = await api.importAppleBooks();
      setAppleResult(result);
      const selected = useStore.getState().selectedId;
      if (selected) await useStore.getState().reloadBook(selected);
      useStore
        .getState()
        .toast(
          result.booksMatched
            ? `Apple Books: ${result.imported} annotazioni, ${result.finishedDates} date di fine e ${result.progressBooks} avanzamenti in ${result.booksMatched} libri`
            : 'Apple Books: nessun libro abbinato alla libreria',
          result.booksMatched ? 'success' : 'info',
        );
    } catch (error) {
      setAppleError((error as Error).message);
    } finally {
      setAppleBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/25 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg animate-scale-in flex-col overflow-hidden rounded-[24px] border border-black/[0.07] bg-white shadow-panel">
        <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-4 sm:px-6">
          <h2 className="text-lg font-semibold text-ink-50">Impostazioni</h2>
          <button onClick={onClose} className="btn-subtle px-2" aria-label="Chiudi impostazioni">
            <IconClose />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="space-y-4">
          <label className="block">
            <span className="field-label">Nome della libreria</span>
            <input
              value={libraryName}
              onChange={(event) => setLibraryName(event.target.value)}
              className="field-input"
            />
          </label>

          <label className="block">
            <span className="field-label">Cartella della libreria</span>
            <div className="flex gap-2">
              <input
                value={libraryRoot}
                onChange={(event) => setLibraryRoot(event.target.value)}
                className="field-input font-mono text-[12px]"
                readOnly={settings.libraryRootLocked}
                disabled={settings.libraryRootLocked}
              />
            </div>
            <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-500">
              <IconFolder className="h-3.5 w-3.5" />
              {settings.libraryRootLocked ? (
                <>
                  Cartella fissata dalla variabile d'ambiente <code className="font-mono">LIBRARY_ROOT</code>: non
                  modificabile da qui.
                </>
              ) : (
                <>
                  Variabile d'ambiente <code className="font-mono">LIBRARY_ROOT</code> per il deployment.
                </>
              )}
            </span>
          </label>

          <label className="block">
            <span className="field-label">Lingua preferita per le ricerche online</span>
            <select
              value={searchLanguage}
              onChange={(event) => setSearchLanguage(event.target.value)}
              className="field-input"
            >
              <option value="it">Italiano</option>
              <option value="en">English</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="es">Español</option>
            </select>
            <span className="mt-1 block text-[11px] text-ink-500">
              Usata solo se il libro non ha già una lingua nei metadati. Se il filtro non
              trova nulla, la ricerca viene ripetuta senza limiti di lingua.
            </span>
          </label>

          <div>
            <span className="field-label">Fonti online</span>
            <div className="space-y-1.5">
              {[
                ['googlebooks', 'Google Books', 'Titolo, editore, copertina, descrizione'],
                ['openlibrary', 'Open Library', 'Metadati aperti e copertine'],
                [
                  'goodreads',
                  'Goodreads',
                  'Volumi mancanti delle serie, cercati tramite ISBN',
                ],
              ].map(([key, label, hint]) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-black/[0.06] bg-ink-800 p-3"
                >
                  <input
                    type="checkbox"
                    checked={providers.includes(key)}
                    onChange={(event) =>
                      setProviders((current) =>
                        event.target.checked
                          ? [...current, key]
                          : current.filter((item) => item !== key),
                      )
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm text-ink-100">{label}</span>
                    <span className="block text-[11px] text-ink-500">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
              Goodreads viene usato solo per le serie e solo quando Open Library e Google Books
              non trovano i volumi. Serve un ISBN nella scheda di almeno un libro; le richieste
              sono limitate e possono richiedere qualche secondo. È una fonte non ufficiale:
              se viene bloccata, puoi riprovare più tardi.
            </p>
          </div>

          <div className="rounded-lg border border-black/[0.06] bg-ink-800 p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="field-label !mb-0">Chiave API Google Books</span>
              {settings.googleBooksApiKeySet || settings.googleBooksApiKeyEnvSet ? (
                <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
                  configurata
                </span>
              ) : (
                <span className="chip border-amber-500/30 bg-amber-500/10 text-amber-700">
                  non configurata
                </span>
              )}
            </div>
            <input
              type="password"
              autoComplete="off"
              value={googleBooksApiKey}
              onChange={(event) => {
                setGoogleBooksApiKey(event.target.value);
                if (event.target.value) setRemoveGoogleBooksKey(false);
              }}
              placeholder={
                settings.googleBooksApiKeySet
                  ? '••••••••••••••  (chiave salvata)'
                  : 'Incolla qui la chiave API…'
              }
              className="field-input font-mono text-[12px]"
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
              È facoltativa, ma senza chiave Google Books limita le richieste anonime e
              risponde <span className="text-ink-300">HTTP 429</span>. La chiave è gratuita:{' '}
              <a
                href="https://developers.google.com/books/docs/v1/getting_started#APIKey"
                target="_blank"
                rel="noreferrer"
                className="text-accent-600 underline decoration-accent-500/40 hover:text-accent-700"
              >
                come ottenerla
              </a>
              . Viene salvata in <code className="font-mono">data/settings.json</code> e non
              viene mai mostrata al browser.
            </p>
            {settings.googleBooksApiKeyEnvSet && (
              <p className="mt-1.5 text-[11px] text-ink-500">
                È attiva anche una chiave dalla variabile d'ambiente{' '}
                <code className="font-mono">GOOGLE_BOOKS_API_KEY</code>.
              </p>
            )}
            {settings.googleBooksApiKeySet && (
              <button
                type="button"
                onClick={() => setRemoveGoogleBooksKey((current) => !current)}
                className="mt-2 text-[11px] text-rose-600/90 underline decoration-rose-500/30 hover:text-rose-700"
              >
                {removeGoogleBooksKey ? 'Annulla rimozione' : 'Rimuovi la chiave salvata'}
              </button>
            )}
            {removeGoogleBooksKey && (
              <p className="mt-1 text-[11px] text-rose-600/80">
                La chiave verrà eliminata quando salvi le impostazioni.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-black/[0.06] bg-ink-800 p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="field-label !mb-0">Jellyfin</span>
              {settings.jellyfinUrl && settings.jellyfinApiKeySet ? (
                <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-700">
                  configurato
                </span>
              ) : (
                <span className="chip border-amber-500/30 bg-amber-500/10 text-amber-700">
                  non configurato
                </span>
              )}
            </div>
            <input
              value={jellyfinUrl}
              onChange={(event) => setJellyfinUrl(event.target.value)}
              placeholder="https://jellyfin.esempio.it"
              className="field-input font-mono text-[12px]"
            />
            <input
              type="password"
              autoComplete="off"
              value={jellyfinApiKey}
              onChange={(event) => {
                setJellyfinApiKey(event.target.value);
                if (event.target.value) setRemoveJellyfinKey(false);
              }}
              placeholder={
                settings.jellyfinApiKeySet
                  ? '••••••••••••••  (chiave salvata)'
                  : 'Incolla qui la chiave API…'
              }
              className="field-input mt-2 font-mono text-[12px]"
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
              La chiave si crea in Jellyfin da Dashboard → Chiavi API. Viene salvata in{' '}
              <code className="font-mono">data/settings.json</code> e non viene mai mostrata al
              browser. Serve per importare la libreria dei libri dalla finestra “Importa”.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={verifyJellyfin}
                disabled={jellyfinBusy || !jellyfinUrl.trim()}
                className="btn-ghost px-3 py-1.5 text-[12px]"
              >
                {jellyfinBusy ? 'Verifico…' : 'Verifica connessione'}
              </button>
              {settings.jellyfinApiKeySet && (
                <button
                  type="button"
                  onClick={() => setRemoveJellyfinKey((current) => !current)}
                  className="text-[11px] text-rose-600/90 underline decoration-rose-500/30 hover:text-rose-700"
                >
                  {removeJellyfinKey ? 'Annulla rimozione' : 'Rimuovi la chiave salvata'}
                </button>
              )}
            </div>
            {removeJellyfinKey && (
              <p className="mt-1 text-[11px] text-rose-600/80">
                La chiave verrà eliminata quando salvi le impostazioni.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-black/[0.06] bg-ink-800 p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="field-label !mb-0">Sottolineature da Apple Books</span>
              <span className="chip border-black/[0.08] text-ink-400">solo macOS</span>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-500">
              Legge le evidenziazioni e le note dal database locale di Libri e le salva
              nei libri abbinati per titolo e autore. L’import è ripetibile: le
              annotazioni già presenti vengono aggiornate, non duplicate.
            </p>
            <button
              type="button"
              onClick={importApple}
              disabled={appleBusy}
              className="btn-ghost mt-2 text-[12px]"
            >
              {appleBusy ? 'Lettura in corso…' : 'Importa da Apple Books'}
            </button>
            {appleError && (
              <p className="mt-2 text-[11px] leading-relaxed text-rose-600">{appleError}</p>
            )}
            {appleResult && (
              <div className="mt-2 rounded-md border border-black/[0.06] bg-ink-900/40 p-2.5 text-[11px] leading-relaxed text-ink-400">
                <p>
                  <strong className="text-ink-200">{appleResult.annotations}</strong>{' '}
                  annotazioni lette ·{' '}
                  <strong className="text-ink-200">{appleResult.booksMatched}</strong> libri
                  abbinati ·{' '}
                  <strong className="text-ink-200">{appleResult.imported}</strong>{' '}
                  annotazioni importate ·{' '}
                  <strong className="text-ink-200">{appleResult.finishedDates}</strong>{' '}
                  date di fine lettura ·{' '}
                  <strong className="text-ink-200">{appleResult.progressBooks}</strong>{' '}
                  avanzamenti
                  {appleResult.booksUpdated !== appleResult.booksMatched
                    ? ` (${appleResult.booksUpdated} libri aggiornati)`
                    : ''}
                  .
                </p>
                {appleResult.unmatched.length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-ink-300">
                      {appleResult.unmatched.length} libri di Apple Books non sono in
                      libreria
                    </summary>
                    <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto pr-1">
                      {appleResult.unmatched.slice(0, 80).map((item) => (
                        <li key={item.assetId} className="truncate">
                          {item.title}
                          {item.author ? ` — ${item.author}` : ''}{' '}
                          <span className="text-ink-600">({item.count})</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-black/[0.06] bg-ink-800 p-3">
            <input
              type="checkbox"
              checked={autoLookup}
              onChange={(event) => setAutoLookup(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm text-ink-100">Compila in automatico</span>
              <span className="block text-[11px] text-ink-500">
                Durante l'importazione cerca i metadati mancanti online e li applica da soli
                (solo se il risultato combacia chiaramente con titolo e autore).
              </span>
            </span>
          </label>

          <label className="block">
            <span className="field-label">Aggiorna le serie ogni</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={365}
                value={seriesRefreshDays}
                onChange={(event) => setSeriesRefreshDays(Number(event.target.value))}
                className="field-input w-24"
              />
              <span className="text-sm text-ink-400">giorni</span>
            </div>
            <span className="mt-1 block text-[11px] leading-relaxed text-ink-500">
              I volumi e le opere online delle serie restano in cache per questo periodo
              (30 giorni di default), anche dopo un riavvio. La cache è in{' '}
              <code className="font-mono">data/series-cache.json</code>; «Aggiorna online»
              la ignora e rifà subito la ricerca.
            </span>
          </label>

          <label className="block">
            <span className="field-label">Parole per ora di lettura</span>
            <input
              type="number"
              min={80}
              max={600}
              value={wordsPerHour}
              onChange={(event) => setWordsPerHour(Number(event.target.value))}
              className="field-input"
            />
          </label>

          <AccountSection />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3.5 sm:px-6">
          <button onClick={onClose} className="btn-ghost">
            Annulla
          </button>
          <button onClick={save} disabled={busy} className="btn-primary">
            Salva
          </button>
        </div>
      </div>
    </div>
  );
}

/** Sezione «Account»: utente collegato, cambio password ed uscita (solo con autenticazione attiva). */
function AccountSection() {
  const { authEnabled, authUser, credentialsSource, logout } = useStore();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!authEnabled) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    if (next.length < 10) return setMessage({ ok: false, text: 'La nuova password deve avere almeno 10 caratteri' });
    if (next !== confirm) return setMessage({ ok: false, text: 'Le due password non coincidono' });
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setMessage({ ok: true, text: 'Password cambiata. Le altre sessioni sono state chiuse.' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const body = err.body as { retryAfter?: number };
        const minutes = Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60));
        setMessage({ ok: false, text: `Troppi tentativi, riprova tra ${minutes} ${minutes === 1 ? 'minuto' : 'minuti'}` });
      } else {
        setMessage({ ok: false, text: (err as Error).message });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-black/[0.06] pt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Account</p>
          <p className="text-sm text-ink-100">{authUser ? `Collegato come ${authUser}` : 'Collegato'}</p>
        </div>
        <button type="button" onClick={() => void logout()} className="btn-ghost text-[12px]">
          <IconLogout className="h-4 w-4" />
          Esci
        </button>
      </div>

      {credentialsSource === 'env' && (
        <p className="text-[12px] text-ink-500">Credenziali impostate dal server (variabili d'ambiente).</p>
      )}
      {credentialsSource === 'file' && (
        <form onSubmit={submit} className="space-y-3">
          <p className="field-label">Cambia password</p>
          <input
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className="field-input"
            placeholder="Password attuale"
            autoComplete="current-password"
            required
          />
          <input
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            className="field-input"
            placeholder="Nuova password (almeno 10 caratteri)"
            autoComplete="new-password"
            required
          />
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="field-input"
            placeholder="Conferma la nuova password"
            autoComplete="new-password"
            required
          />
          {message && (
            <p
              role={message.ok ? 'status' : 'alert'}
              className={message.ok ? 'text-[12px] text-emerald-700' : 'text-[12px] text-rose-600'}
            >
              {message.text}
            </p>
          )}
          <button type="submit" disabled={busy} className="btn-subtle">
            {busy ? 'Salvataggio…' : 'Cambia password'}
          </button>
        </form>
      )}
    </div>
  );
}
