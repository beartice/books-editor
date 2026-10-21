/**
 * Normalizzazione dei tag che arrivano dai metadati importati.
 *
 * Le categorie composte ("Fiction / Fantasy", "Fiction, romance, general")
 * diventano tag singoli. Restano interi i pairing ("M/M", "F/M",
 * "Nome1/Nome2") e le frasi in cui la barra non separa una categoria
 * (es. "site/app").
 */

const GENDER_PAIRING = /^[MFX](\s*\/\s*[MFX])+$/i;
const WORD_PAIRING =
  /^(?:teenage\s+)?(?:boy|girl|male|female)\s*\/\s*(?:boy|girl|male|female)$/i;

function firstWord(value: string): string {
  return value.trim().replace(/^\(/, '').split(/\s+/)[0] ?? '';
}

function lastWord(value: string): string {
  const words = value.trim().split(/\s+/);
  return words[words.length - 1] ?? '';
}

/** Parola con l'iniziale maiuscola: indizio di un nome proprio. */
function looksLikeName(value: string): boolean {
  return /^\p{Lu}[\p{L}'’.-]*$/u.test(value.replace(/[),]+$/, ''));
}

/** Pairing: coppia di nomi o codici di genere, da non spezzare. */
function isPairing(tag: string): boolean {
  if (GENDER_PAIRING.test(tag) || WORD_PAIRING.test(tag)) return true;
  // Nome1/Nome2: una sola barra attaccata ai nomi, entrambi maiuscoli.
  if (tag.includes(',') || /\s\/\s/.test(tag)) return false;
  const parts = tag.split('/');
  if (parts.length !== 2) return false;
  return looksLikeName(lastWord(parts[0])) && looksLikeName(firstWord(parts[1]));
}

/**
 * La barra separa solo categorie: "Fiction / Fantasy" (spazi attorno) oppure
 * "Fantasy/Horror" o "Contesto generale/vago" (iniziali maiuscole).
 * "site/app" resta un tag unico.
 */
function splitsOnSlash(tag: string): boolean {
  if (/\s\/\s/.test(tag)) return true;
  return tag.split('/').some((part) => /^\s*\p{Lu}/u.test(part));
}

/**
 * Soggetti che contengono una barra ma non sono tag composti (note, slogan):
 * vanno lasciati interi.
 */
const KEEP_INTACT = new Set([
  'Do not translate without permission or copy to another site/app',
]);

function splitSlashes(tag: string, force: boolean): string[] {
  if (!tag.includes('/') || isPairing(tag) || KEEP_INTACT.has(tag)) return [tag];
  if (!force && !splitsOnSlash(tag)) return [tag];
  return tag
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitTag(raw: string): string[] {
  const tag = raw.trim();
  if (!tag) return [];
  // Se c'e' una virgola il tag e' gia' un elenco: separiamo anche le barre.
  if (!tag.includes(',')) return splitSlashes(tag, false);
  return tag.split(',').flatMap((part) => splitSlashes(part.trim(), true));
}

/** Divide i tag composti e rimuove i duplicati (senza badare alle maiuscole). */
export function normalizeTags(tags: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    for (const part of splitTag(tag)) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(part);
    }
  }
  return result;
}
