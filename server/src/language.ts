/** Codici lingua ISO 639-2 usati negli EPUB ("ita", "ger") -> 639-1 ("it", "de"). */
const LANGUAGE_639_1: Record<string, string> = {
  ita: 'it', eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es',
  por: 'pt', dut: 'nl', nld: 'nl', jpn: 'ja', rus: 'ru', chi: 'zh', zho: 'zh',
  pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', tur: 'tr', gre: 'el', ell: 'el',
};

/** "en-US" -> "en", "ita" -> "it"; undefined se il codice non e' riconosciuto. */
export function toIso6391(value: string): string | undefined {
  const code = value.toLowerCase().split(/[-_]/)[0] ?? '';
  if (/^[a-z]{2}$/.test(code)) return code;
  return LANGUAGE_639_1[code];
}

/** Parole funzionali frequenti per lingua, per riconoscere la lingua di un testo. */
const STOPWORDS: Record<string, string[]> = {
  it: ['il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'di', 'che', 'e', 'non', 'per', 'con', 'del', 'della', 'dei', 'nel', 'era', 'sono', 'come', 'ma', 'anche', 'questo', 'aveva', 'si', 'poi', 'solo'],
  en: ['the', 'and', 'of', 'to', 'in', 'was', 'that', 'it', 'he', 'she', 'his', 'her', 'with', 'for', 'had', 'you', 'not', 'on', 'as', 'at', 'they', 'but', 'were', 'be', 'this', 'from'],
  fr: ['le', 'la', 'les', 'des', 'du', 'et', 'est', 'une', 'un', 'que', 'qui', 'dans', 'pas', 'pour', 'il', 'elle', 'ne', 'se', 'sur', 'avec', 'mais', 'au', 'ce', 'je', 'vous', 'nous'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'no', 'se', 'su', 'para', 'del', 'al', 'lo', 'como', 'mas', 'pero', 'sus', 'era', 'estaba'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'sie', 'er', 'es', 'auf', 'dem', 'von', 'sich', 'des', 'war', 'aber', 'auch', 'wie', 'ich'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'nao', 'se', 'por', 'mais', 'foi', 'ele', 'ela', 'mas', 'dos', 'das', 'como'],
};

/**
 * Riconosce la lingua di un testo dalle parole funzionali piu' frequenti.
 * Restituisce il codice ISO 639-1 solo con un margine netto, altrimenti ''.
 */
export function detectLanguage(text: string): string {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z]+/g);
  if (!words || words.length < 80) return '';
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const scores: Array<[string, number]> = Object.entries(STOPWORDS).map(([code, list]) => {
    let hits = 0;
    for (const word of new Set(list)) hits += counts.get(word) ?? 0;
    return [code, hits / words.length];
  });
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  // Serve una densita' minima di parole funzionali e un vantaggio netto sulla seconda.
  if (best[1] < 0.08 || best[1] < second[1] * 1.3) return '';
  return best[0];
}
