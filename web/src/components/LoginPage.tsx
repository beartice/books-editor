import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useStore } from '../store';
import { IconBook } from './icons';

/** Pagina di accesso: mostrata da sola quando serve la sessione. */
export default function LoginPage() {
  const { authMessage, loggedIn } = useStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      setPassword('');
      await loggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const body = err.body as { retryAfter?: number };
        const minutes = Math.max(1, Math.ceil((body.retryAfter ?? 60) / 60));
        setError(`Troppi tentativi, riprova tra ${minutes} ${minutes === 1 ? 'minuto' : 'minuti'}`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-[#ede9de] px-4">
      <form onSubmit={submit} className="panel w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-600 text-white">
            <IconBook className="h-5 w-5" />
          </span>
          <div>
            <p className="eyebrow">Libreria</p>
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink-50">Accedi</h1>
          </div>
        </div>

        {authMessage && !error && (
          <p className="mb-4 rounded-xl bg-black/[0.04] px-3 py-2 text-sm text-ink-300">{authMessage}</p>
        )}
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
        <label className="mb-6 block">
          <span className="field-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field-input"
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? 'Accesso in corso…' : 'Accedi'}
        </button>
      </form>
    </div>
  );
}
