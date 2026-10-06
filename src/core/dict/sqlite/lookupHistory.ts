// Lookup history (ADR-0011). Records every DOC lookup Kindle-vocab.db
// style — the selected word, the sentence it sat in, the document it
// came from — into user.db's `lookups` table, so an exported user.db
// can feed a flashcard pipeline.
//
// Best-effort by design: any missing context piece is stored as NULL,
// and recordLookup NEVER rejects (a failed INSERT only logs), so history
// can't break or delay the define flow that fires it.

import type {APIResponse, Logger} from '../../../sdk/types';
import {unwrap} from '../../../sdk/unwrap';
import type {SqliteDb} from './db';
import {INSERT_LOOKUP} from './schema';

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
  db: SqliteDb | null;
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
  const {db, comm, doc, logger, now = () => new Date().toISOString()} = deps;
  if (db === null) {
    return;
  }
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
    await db.run(INSERT_LOOKUP, [word, usage, book, now()]);
  } catch (e) {
    logger.warn(`[history] lookup not saved: ${(e as Error).message}`);
  }
};
