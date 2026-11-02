import type {
  BookMeta,
  TagCleanupGroup,
  TagCleanupPlan,
  TagCleanupSelection,
  TagVariant,
} from '../../shared/types.js';

/*
 * Regole della pulizia dei tag dei libri (le fanfic hanno tag AO3 gia' canonici e non si toccano).
 * La proposta e' deterministica: grafie diverse dello stesso tag si uniscono, i prefissi
 * da catalogo si tolgono, i sinonimi e le traduzioni confluiscono in un canonico, il rumore
 * si toglie. Le stesse regole servono ai metadati in ingresso (`cleanIncomingTags`).
 */

/** Lunghezza massima di un nome di tag rinominato dall'utente. */
export const TAG_NAME_MAX = 100;

/**
 * Sinonimi e traduzioni: canonico (in inglese, come la maggior parte dei tag) -> varianti.
 * Si confrontano le chiavi normalizzate (minuscolo, senza accenti, `-` e `_` come spazi).
 * Nel dubbio non si unisce: queer resta separato da LGBTQ+, dark fantasy da fantasy.
 */
export const TAG_SYNONYMS: Record<string, string[]> = {
  Romance: ['romance fiction', 'love stories', 'love & romance', 'romantico', 'romantica', 'sentimentale', 'love'],
  Fantasy: ['fantasy fiction', 'fantasy & magic', 'fantastico'],
  'Science fiction': ['sci-fi', 'scifi', 'fantascienza'],
  Thriller: ['thrillers', 'thrillers & suspense', 'thriller e gialli'],
  Mystery: ['giallo', 'gialli'],
  Horror: ['horror fiction'],
  Humor: ['humorous', 'humour', 'umoristico'],
  'Historical fiction': ['historical', 'romanzo storico', 'storico'],
  'Fairy tales': ['fairy tales & folklore', 'folk tales', 'fiabe'],
  'Young adult': ['young adult fiction', 'young adult works'],
  "Children's fiction": ['juvenile fiction', 'juvenile works', 'ragazzi'],
  Drama: ['drammatico'],
  'LGBTQ+': ['lgbt', 'lgbtq'],
  Vampires: ['vampire'],
  'Coming of age': ['romanzo di formazione'],
  'Kings and rulers': ['kings', 'queens', 'rulers'],
  // Solo grafie: nessuna variante, il canonico fissa maiuscole e forma.
  'Contemporary romance': [],
  'Paranormal romance': [],
  'Dark romance': [],
};

/** Gruppi `remove`: id -> descrizione. Tutti proposti di default. */
const REMOVE_LABELS = {
  'remove:catalog-series': 'Prefisso «Serie:» o «Series:» del catalogo (la serie è già un campo)',
  'remove:catalog-form': 'Prefisso «form:» del catalogo',
  'remove:generic': 'Tag generici (fiction, general, novel, book, ebook)',
  'remove:bestseller': 'Etichette del New York Times',
  'remove:junk': 'Frammenti senza significato',
  'remove:symbols': 'Tag vuoti o di soli simboli',
} as const;
type RemoveId = keyof typeof REMOVE_LABELS;

/** Tag-rumore: chiave normalizzata -> gruppo. */
const NOISE: Record<string, RemoveId> = {
  fiction: 'remove:generic',
  general: 'remove:generic',
  'fiction general': 'remove:generic',
  novel: 'remove:generic',
  novels: 'remove:generic',
  book: 'remove:generic',
  books: 'remove:generic',
  ebook: 'remove:generic',
  'new york times bestseller': 'remove:bestseller',
  'new york times reviewed': 'remove:bestseller',
  'etc.)': 'remove:junk',
  'people & places': 'remove:junk',
};

/* --------------------------------------------------------- classificazione -- */

/** Chiave di confronto: maiuscole, accenti, spazi, trattini e `_` non contano. */
export function tagKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

const SYNONYM_BY_KEY = new Map<string, string>();
for (const [canonical, variants] of Object.entries(TAG_SYNONYMS)) {
  SYNONYM_BY_KEY.set(tagKey(canonical), canonical);
  for (const variant of variants) SYNONYM_BY_KEY.set(tagKey(variant), canonical);
}

type Classified =
  | { action: 'remove'; id: RemoveId }
  | { action: 'keep'; display: string; key: string; canonical: string | null };

/** Cosa fare di un tag: toglierlo, oppure tenerlo con la sua forma pulita e l'eventuale canonico dei sinonimi. */
function classify(raw: string): Classified {
  let text = raw.trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return { action: 'remove', id: 'remove:symbols' };
  if (/^(?:serie|series)\s*:/i.test(text)) return { action: 'remove', id: 'remove:catalog-series' };
  if (/^form\s*:/i.test(text)) return { action: 'remove', id: 'remove:catalog-form' };
  const genre = /^genre\s*:\s*(.+)$/i.exec(text);
  if (genre) text = genre[1];
  const fiction = /^(.+?)\s*(?:--|—|–)\s*fiction$/i.exec(text);
  if (fiction) text = fiction[1];
  text = text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return { action: 'remove', id: 'remove:symbols' };
  const key = tagKey(text);
  const noise = NOISE[key];
  if (noise) return { action: 'remove', id: noise };
  return { action: 'keep', display: text, key, canonical: SYNONYM_BY_KEY.get(key) ?? null };
}

/** Chiave del gruppo `merge` di un tag mantenuto. */
const groupKey = (item: Extract<Classified, { action: 'keep' }>) =>
  item.canonical ? tagKey(item.canonical) : item.key;

/**
 * Pulizia dei tag di un libro in ingresso (import, metadati online): stesse regole della
 * pulizia della libreria, senza statistiche d'uso. I sinonimi vanno al canonico, il resto
 * conserva la grafia ricevuta; i duplicati cadono.
 */
export function cleanIncomingTags(tags: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const item = classify(raw);
    if (item.action === 'remove') continue;
    const tag = item.canonical ?? item.display;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/* ---------------------------------------------------------------- proposta -- */

/** Forma "solo iniziale maiuscola" ("Enemies to lovers"). */
const onlyInitialCapital = (value: string) => /^\p{Lu}[^\p{Lu}]*$/u.test(value);

/** Iniziale maiuscola ("Epic", non "epic"): la grafia preferita, anche se meno usata. */
const initialCapital = (value: string) => /^\p{Lu}/u.test(value);

function chooseCanonical(counts: Map<string, number>): string {
  const ranked = [...counts].sort((a, b) => {
    const upA = initialCapital(a[0]);
    const upB = initialCapital(b[0]);
    if (upA !== upB) return upA ? -1 : 1;
    if (b[1] !== a[1]) return b[1] - a[1];
    const capA = onlyInitialCapital(a[0]);
    const capB = onlyInitialCapital(b[0]);
    if (capA !== capB) return capA ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });
  return ranked[0][0];
}

/** Tag di un libro dopo aver applicato i gruppi scelti (`canonicals`: id -> nome finale). */
export function applyToTags(
  tags: readonly string[],
  removed: Set<string>,
  canonicals: Map<string, string>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const item = classify(raw);
    let tag = raw;
    if (item.action === 'remove') {
      if (removed.has(item.id)) continue;
    } else {
      const replacement = canonicals.get(`merge:${groupKey(item)}`);
      if (replacement !== undefined) tag = replacement;
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/** Proposta di pulizia per i libri indicati (le fanfic vengono ignorate). */
export function planTagCleanup(books: BookMeta[]): TagCleanupPlan {
  const target = books.filter((book) => book.kind === 'book');
  const removeGroups = new Map<string, { variants: Map<string, Set<string>> }>();
  const merges = new Map<
    string,
    { raws: Map<string, Set<string>>; displays: Map<string, number>; canonical: string | null }
  >();

  for (const book of target) {
    for (const raw of new Set(book.tags ?? [])) {
      const item = classify(raw);
      if (item.action === 'remove') {
        const group = removeGroups.get(item.id) ?? { variants: new Map() };
        const ids = group.variants.get(raw) ?? new Set();
        ids.add(book.id);
        group.variants.set(raw, ids);
        removeGroups.set(item.id, group);
        continue;
      }
      const key = groupKey(item);
      const group = merges.get(key) ?? { raws: new Map(), displays: new Map(), canonical: item.canonical };
      const ids = group.raws.get(raw) ?? new Set();
      ids.add(book.id);
      group.raws.set(raw, ids);
      group.displays.set(item.display, (group.displays.get(item.display) ?? 0) + 1);
      merges.set(key, group);
    }
  }

  const variantsOf = (raws: Map<string, Set<string>>): TagVariant[] =>
    [...raws]
      .map(([tag, ids]) => ({ tag, count: ids.size }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const idsOf = (raws: Map<string, Set<string>>): string[] => [...new Set([...raws.values()].flatMap((ids) => [...ids]))];

  const groups: TagCleanupGroup[] = [];
  for (const [key, group] of merges) {
    const canonical = group.canonical ?? chooseCanonical(group.displays);
    // Un solo tag gia' scritto come il canonico: niente da unire.
    if (group.raws.size === 1 && group.raws.has(canonical)) continue;
    groups.push({
      id: `merge:${key}`,
      kind: 'merge',
      canonical,
      label: '',
      variants: variantsOf(group.raws),
      // Solo i libri che cambiano: quelli che hanno gia' solo il canonico restano fuori.
      bookIds: idsOf(new Map([...group.raws].filter(([tag]) => tag !== canonical))),
      defaultSelected: true,
    });
  }
  groups.sort((a, b) => b.bookIds.length - a.bookIds.length || a.canonical.localeCompare(b.canonical));

  for (const id of Object.keys(REMOVE_LABELS) as RemoveId[]) {
    const group = removeGroups.get(id);
    if (!group) continue;
    groups.push({
      id,
      kind: 'remove',
      canonical: '',
      label: REMOVE_LABELS[id],
      variants: variantsOf(group.variants),
      bookIds: idsOf(group.variants),
      defaultSelected: true,
    });
  }

  // Totali con le scelte predefinite: libri toccati e tag distinti prima e dopo.
  const defaults = selectedState(groups.filter((group) => group.defaultSelected).map((group) => ({ id: group.id })), groups);
  const before = new Set<string>();
  const after = new Set<string>();
  let touched = 0;
  for (const book of target) {
    const next = applyToTags(book.tags ?? [], defaults.removed, defaults.canonicals);
    for (const tag of book.tags ?? []) before.add(tag);
    for (const tag of next) after.add(tag);
    if (JSON.stringify(next) !== JSON.stringify(book.tags ?? [])) touched += 1;
  }
  return { groups, totals: { books: touched, tagsBefore: before.size, tagsAfter: after.size }, lastCleanup: null };
}

/** Gruppi scelti -> insiemi usati da `applyToTags`. Gli id sconosciuti si scartano. */
export function selectedState(
  selection: TagCleanupSelection[],
  groups: TagCleanupGroup[],
): { removed: Set<string>; canonicals: Map<string, string>; used: TagCleanupSelection[] } {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const removed = new Set<string>();
  const canonicals = new Map<string, string>();
  const used: TagCleanupSelection[] = [];
  for (const choice of selection) {
    const group = byId.get(choice.id);
    if (!group) continue;
    used.push(choice);
    if (group.kind === 'remove') removed.add(group.id);
    else canonicals.set(group.id, choice.canonical?.trim() || group.canonical);
  }
  return { removed, canonicals, used };
}

