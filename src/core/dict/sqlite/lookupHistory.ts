// Lookup history (ADR-0011). Records every DOC lookup Kindle-vocab.db
// style — the selected word, the sentence it sat in, the document it
// came from — into the `lookups` table of a standalone vocab.db that
// lives in shared storage, so it can be read straight over USB to feed
// a flashcard pipeline.
//
// The DB is opened, written and closed per lookup: no handle is held
// between lookups (a user deleting the file can't swallow later rows,
// and closing folds any WAL back so only vocab.db is left on disk).
//
// Best-effort by design: any missing context piece is stored as NULL,
// and recordLookup NEVER rejects (a failed open/INSERT only logs), so
// history can't break or delay the define flow that fires it.

import type {APIResponse, Logger} from '../../../sdk/types';
import {unwrap} from '../../../sdk/unwrap';
import type {OpenSqliteDb} from './db';
import {CREATE_LOOKUPS_TABLE, INSERT_LOOKUP} from './schema';

// Max chars kept on each side of the word when no sentence end is near
// (PDF tables, unpunctuated text).
const CONTEXT_RADIUS = 150;

// The sentence around `selected` in `pageText`, whitespace-collapsed;
// null when the selection isn't on the page.
// ponytail: first occurrence wins — the SDK exposes no selection offset,
// so a word repeated on the page may get the wrong sentence; "Mr." etc.
// also ends a sentence early.
export const sentenceAround = (
  pageText: string,
  selected: string,
): string | null => {
  const text = pageText.replace(/\s+/g, ' ');
  const word = selected.trim().replace(/\s+/g, ' ');
  const at = text.indexOf(word);
  if (word.length === 0 || at < 0) {
    return null;
  }
  const floor = Math.max(0, at - CONTEXT_RADIUS);
  let start = at;
  while (start > floor && !'.!?'.includes(text[start - 1])) {
    start--;
  }
  const after = at + word.length;
  const endMatch = /[.!?]/.exec(text.slice(after, after + CONTEXT_RADIUS));
  const end = endMatch ? after + endMatch.index + 1 : after + CONTEXT_RADIUS;
  return text.slice(start, end).trim();
};

export type LookupHistoryDeps = {
  // Opens (creating if needed) vocab.db; null = unavailable (e.g. no
  // file permission), which makes the lookup a silent no-op.
  openDb: OpenSqliteDb;
  comm: {
    getCurrentFilePath: () => Promise<APIResponse<string>>;
    getCurrentPageNum: () => Promise<APIResponse<number>>;
  };
  doc: {
    getCurrentDocText: (page: number) => Promise<APIResponse<string>>;
  };
  logger: Logger;
  now?: () => string;
};

const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const recordLookup = async (
  deps: LookupHistoryDeps,
  word: string,
): Promise<void> => {
  const {openDb, comm, doc, logger, now = () => new Date().toISOString()} =
    deps;
  try {
    const [path, page] = await Promise.all([
      orNull(comm.getCurrentFilePath().then(r => unwrap(r, 'getCurrentFilePath'))),
      orNull(comm.getCurrentPageNum().then(r => unwrap(r, 'getCurrentPageNum'))),
    ]);
    const pageText =
      page === null
        ? null
        : await orNull(
            doc.getCurrentDocText(page).then(r => unwrap(r, 'getCurrentDocText')),
          );
    const usage = pageText === null ? null : sentenceAround(pageText, word);
    const book = path === null ? null : path.slice(path.lastIndexOf('/') + 1);
    const db = await openDb();
    if (db === null) {
      return;
    }
    try {
      await db.run(CREATE_LOOKUPS_TABLE);
      await db.run(INSERT_LOOKUP, [word, usage, book, now()]);
    } finally {
      await db.close();
    }
  } catch (e) {
    logger.warn(`[history] lookup not saved: ${(e as Error).message}`);
  }
};
