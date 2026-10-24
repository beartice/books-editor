import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { Ao3SessionState } from '@shared/types';

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Account AO3: serve per controllare e scaricare le opere riservate agli utenti
 * registrati. La password si usa solo per l'accesso e non viene salvata.
 */
export default function Ao3AccountSection() {
  const toast = useStore((state) => state.toast);
  const [session, setSession] = useState<Ao3SessionState | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.ao3Session().then(setSession).catch(() => setSession(null));
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const user = username.trim();
    const pass = password;
    if (!user || !pass) return;
    // La password esce dallo stato del componente appena parte l'invio.
    setPassword('');
    setBusy(true);
    setError('');
    try {
      const next = await api.ao3Login(user, pass);
      setSession(next);
      setUsername('');
      toast(`Accesso ad AO3 eseguito come ${next.username ?? user}`, 'success');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      setSession(await api.ao3Logout());
      toast('Uscito da AO3', 'success');
    } catch (failure) {
      toast((failure as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const connected = Boolean(session?.loggedIn);

  return (
    <div className="rounded-lg border border-black/[0.06] bg-ink-800 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="field-label !mb-0">Account AO3</span>
        {connected ? (
          <span className="chip border-emerald-500/30 bg-emerald-500/10 text-emerald-700">collegato</span>
        ) : (
          <span className="chip border-amber-500/30 bg-amber-500/10 text-amber-700">
            {session?.expired ? 'sessione scaduta' : 'non collegato'}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-ink-500">
        Con l'accesso l'app può controllare e scaricare anche le opere riservate agli utenti
        registrati di AO3.
      </p>
      {connected ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-[12px] text-ink-300">
            Collegato come <strong>{session?.username}</strong>
            {session?.loggedInAt ? ` dal ${formatDateTime(session.loggedInAt)}` : ''}
          </p>
          <button type="button" onClick={logout} disabled={busy} className="btn-ghost px-3 py-1.5 text-[12px]">
            Esci
          </button>
        </div>
      ) : (
        <form onSubmit={login} className="mt-2 space-y-2">
          {session?.expired && (
            <p className="text-[11px] text-amber-700">
              AO3 non accetta più la sessione di {session.username}: accedi di nuovo.
            </p>
          )}
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Utente AO3"
            className="field-input"
          />
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password AO3"
            className="field-input"
          />
          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="btn-ghost text-[12px] disabled:opacity-60"
          >
            {busy ? 'Accesso in corso…' : 'Accedi'}
          </button>
          {error && <p className="text-[11px] leading-relaxed text-rose-600">{error}</p>}
        </form>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
        La password non viene salvata: il server conserva solo la sessione di AO3.
      </p>
    </div>
  );
}
