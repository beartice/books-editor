import type { AppleBooksRawData } from '../../shared/types.js';

/** Limiti dei dati inviati dall'app per Mac a `POST /api/apple-books/import-data`. */
export const MAX_APPLE_ANNOTATIONS = 200000;
export const MAX_APPLE_LIBRARY = 50000;
const MAX_TEXT = 100000;
const MAX_LOCATION = 4000;
const MAX_SHORT = 500;
const MAX_BOOK_IDS = 50000;

export class AppleBooksInputError extends Error {
  constructor(
    message: string,
    /** 413 se i dati superano i limiti di quantita', altrimenti 400. */
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Campo opzionale: assente, null, stringa entro `max` caratteri (o numero, se `numeric`). */
function checkField(
  row: Record<string, unknown>,
  name: string,
  max: number,
  where: string,
  numeric = false,
): void {
  const value = row[name];
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    if (value.length > max) throw new AppleBooksInputError(`${where}: campo «${name}» troppo lungo`);
    return;
  }
  if (numeric && typeof value === 'number' && Number.isFinite(value)) return;
  throw new AppleBooksInputError(`${where}: campo «${name}» non valido`);
}

/** Controlla il corpo della richiesta; lancia AppleBooksInputError se non e' del tipo atteso. */
export function parseAppleBooksInput(body: unknown): {
  data: AppleBooksRawData;
  dryRun: boolean;
  bookIds?: string[];
} {
  if (!isObject(body)) throw new AppleBooksInputError('Richiesta non valida');
  const { annotations, library, dryRun, bookIds } = body;
  if (!Array.isArray(annotations)) throw new AppleBooksInputError('«annotations» deve essere un elenco');
  if (!Array.isArray(library)) throw new AppleBooksInputError('«library» deve essere un elenco');
  if (annotations.length > MAX_APPLE_ANNOTATIONS) {
    throw new AppleBooksInputError('Troppe annotazioni', 413);
  }
  if (library.length > MAX_APPLE_LIBRARY) throw new AppleBooksInputError('Troppi libri', 413);
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new AppleBooksInputError('«dryRun» deve essere vero o falso');
  }
  let ids: string[] | undefined;
  if (bookIds !== undefined) {
    if (
      !Array.isArray(bookIds) ||
      bookIds.length > MAX_BOOK_IDS ||
      !bookIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_SHORT)
    ) {
      throw new AppleBooksInputError('«bookIds» deve essere un elenco di testi');
    }
    ids = bookIds as string[];
  }

  annotations.forEach((row, index) => {
    const where = `Annotazione ${index + 1}`;
    if (!isObject(row)) throw new AppleBooksInputError(`${where}: non valida`);
    checkField(row, 'uuid', MAX_SHORT, where);
    checkField(row, 'assetId', MAX_SHORT, where);
    checkField(row, 'text', MAX_TEXT, where);
    checkField(row, 'note', MAX_TEXT, where);
    checkField(row, 'location', MAX_LOCATION, where);
    checkField(row, 'style', MAX_SHORT, where, true);
    checkField(row, 'underline', MAX_SHORT, where, true);
    checkField(row, 'createdAt', MAX_SHORT, where, true);
    checkField(row, 'modifiedAt', MAX_SHORT, where, true);
  });
  library.forEach((row, index) => {
    const where = `Libro ${index + 1}`;
    if (!isObject(row)) throw new AppleBooksInputError(`${where}: non valido`);
    checkField(row, 'assetId', MAX_SHORT, where);
    for (const name of ['title', 'sortTitle', 'author', 'sortAuthor']) {
      checkField(row, name, MAX_TEXT, where);
    }
    checkField(row, 'finishedAt', MAX_SHORT, where, true);
    checkField(row, 'readingProgress', MAX_SHORT, where, true);
    checkField(row, 'lastOpenedAt', MAX_SHORT, where, true);
    // Facoltativi: le vecchie app Mac non li mandano.
    checkField(row, 'addedAt', MAX_SHORT, where, true);
    checkField(row, 'lastEngagedAt', MAX_SHORT, where, true);
    checkField(row, 'firstOpenedAt', MAX_SHORT, where, true);
  });

  return {
    data: {
      database: 'app Mac',
      annotations: annotations as AppleBooksRawData['annotations'],
      library: library as AppleBooksRawData['library'],
    },
    dryRun: dryRun === true,
    bookIds: ids,
  };
}
