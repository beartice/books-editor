import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useStore } from '../store';
import { IconBook } from './icons';

/** Primo avvio: creazione dell'account. Mostrata da sola finche' non esiste un account. */
export default function SetupPage() {
  const { setupCodeRequired, setupLibraryRoot, setupLibraryRootLocked, loggedIn } = useStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [libraryRoot, setLibraryRoot] = useState(setupLibraryRoot ?? '');
  // Il valore iniziale puo' arrivare dopo il primo render, finche' l'utente non lo modifica.
  const rootTouched = useRef(false);
  useEffect(() => {
    if (!rootTouched.current) setLibraryRoot(setupLibraryRoot ?? '');
  }, [setupLibraryRoot]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    // Stessi controlli del server.
    if (username !== username.trim() || username.length < 3 || username.length > 64) {
      setError('Il nome utente deve avere da 3 a 64 caratteri, senza spazi ai lati');
      return;
    }
    if (password.length < 10) {
      setError('La password deve avere almeno 10 caratteri');
      return;
    }
    if (password === username) {
      setError('La password deve essere diversa dal nome utente');
      return;
    }
    if (password !== confirm) {
      setError('Le due password non coincidono');
      return;
    }
    setBusy(true);
    try {
      const rootChanged = !setupLibraryRootLocked && libraryRoot.trim() !== (setupLibraryRoot ?? '');
      await api.setup(
        username,
        password,
        setupCodeRequired ? code : undefined,
        rootChanged ? libraryRoot.trim() : undefined,
      );
      setPassword('');
      setConfirm('');
      await loggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const body = err.body as { retryAfter?: number };
        const minutes = Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60));
        setError(`Troppi tentativi, riprova tra ${minutes} ${minutes === 1 ? 'minuto' : 'minuti'}`);
      } else if (err instanceof ApiError && err.status === 409) {
        // Account creato nel frattempo: si passa al login.
        await loggedIn();
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full overflow-y-auto bg-[#ede9de] px-4 py-4">
      <form onSubmit={submit} className="panel m-auto w-full max-w-sm p-5 sm:p-7">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-600 text-white">
            <IconBook className="h-5 w-5" />
          </span>
          <div>
            <p className="eyebrow">Libreria</p>
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink-50">Crea il tuo account</h1>
          </div>
        </div>

        <p className="mb-4 rounded-xl bg-black/[0.04] px-3 py-2 text-sm text-ink-300">
          Benvenuto! E' il primo avvio: scegli nome utente e password per proteggere la tua libreria.
        </p>
        {error && (
          <p role="alert" className="mb-4 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-600">
            {error}
          </p>
        )}

        <label className="mb-4 block">
          <span className="field-label">Nome utente</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="field-input"
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label className="mb-4 block">
          <span className="field-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-input"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <span className="mt-1 block text-[11px] text-ink-500">Almeno 10 caratteri.</span>
        </label>
        <label className="mb-4 block">
          <span className="field-label">Conferma password</span>
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="field-input"
            autoComplete="new-password"
            required
          />
        </label>
        <label className="mb-4 block">
          <span className="field-label">Cartella della libreria</span>
          <input
            value={libraryRoot}
            onChange={(event) => {
              rootTouched.current = true;
              setLibraryRoot(event.target.value);
            }}
            className="field-input font-mono"
            placeholder={setupLibraryRoot === null ? 'Lascia vuoto per la cartella predefinita' : undefined}
            readOnly={setupLibraryRootLocked}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="mt-1 block text-[11px] text-ink-500">
            {setupLibraryRootLocked
              ? 'Impostata dal server con la variabile LIBRARY_ROOT.'
              : 'Qui vengono salvati gli ebook, le copertine e i metadati. Se la cartella contiene gia\' una libreria, verra\' letta. Puoi cambiarla in seguito dalle impostazioni.'}
          </span>
        </label>
        {setupCodeRequired && (
          <label className="mb-4 block">
            <span className="field-label">Codice di configurazione</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="field-input font-mono"
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <span className="mt-1 block text-[11px] text-ink-500">
              Lo trovi nei log del server (<code className="font-mono">docker compose logs libreria</code>) o nel
              file <code className="font-mono">.setup-code</code> nella cartella dei dati.
            </span>
          </label>
        )}

        <button type="submit" disabled={busy} className="btn-primary mt-2 w-full">
          {busy ? 'Creazione in corso…' : 'Crea account'}
        </button>
      </form>
    </div>
  );
}
