import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 5;
const BLOCKED_MESSAGE = 'Indirizzo non consentito: rete interna o non valido';

/** Espande un IPv6 in 8 gruppi da 16 bit; null se non valido. */
function expandIPv6(address: string): number[] | null {
  let text = address.split('%')[0].toLowerCase();
  // Coda IPv4 incorporata (es. ::ffff:127.0.0.1).
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.some((n) => n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    text = text.slice(0, -dotted[1].length) + `${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const numbers = groups.map((group) => parseInt(group, 16));
  if (numbers.length !== 8 || numbers.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return numbers;
}

function isBlockedIPv4(a: number, b: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast e riservati
  );
}

/** true se l'indirizzo IP e' di una rete non pubblica. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return isBlockedIPv4(a, b);
  }
  if (family === 6) {
    const g = expandIPv6(address);
    if (!g) return true;
    const v4 = (hi: number, lo: number) => isBlockedIPv4(hi >> 8, hi & 0xff) && lo >= 0;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    // IPv4 mappato (::ffff:a.b.c.d) o compatibile (::a.b.c.d)
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]);
    // NAT64 64:ff9b::/96
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]);
    return false;
  }
  return true;
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(BLOCKED_MESSAGE);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error(BLOCKED_MESSAGE);
  let addresses: string[];
  try {
    const results = await dns.lookup(host, { all: true });
    addresses = results.map((item) => item.address);
  } catch {
    throw new Error('Indirizzo non raggiungibile');
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new Error(BLOCKED_MESSAGE);
}

/**
 * fetch per URL date dall'utente: consente solo http/https verso indirizzi
 * pubblici e segue i redirect a mano, rivalidando ogni destinazione.
 * Nota: tra il controllo DNS e la connessione non c'e' blocco dell'IP
 * (rebinding), limite accettato.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error(BLOCKED_MESSAGE);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(url);
    const response = await fetch(url, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel().catch(() => undefined);
      try {
        url = new URL(location, url);
      } catch {
        throw new Error(BLOCKED_MESSAGE);
      }
      continue;
    }
    return response;
  }
  throw new Error('Troppi reindirizzamenti');
}
