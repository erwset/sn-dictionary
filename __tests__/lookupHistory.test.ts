// Lookup history (ADR-0011): sentence extraction + best-effort persistence.

import {createSeededDb} from './_helpers/betterSqliteDb';
import {
  recordLookup,
  sentenceAround,
  type LookupHistoryDeps,
} from '../src/core/dict/sqlite/lookupHistory';
import {CREATE_LOOKUPS_TABLE} from '../src/core/dict/sqlite/schema';
import type {SqliteDb} from '../src/core/dict/sqlite/db';

const ok = <T>(result: T) => ({success: true, result});
const fail = (message: string) => ({success: false, error: {code: 1, message}});

const PAGE =
  'It was a dark night. The crowd began to jeer at\nthe   speaker! Nobody left.';

const historyDb = (): Promise<SqliteDb> =>
  createSeededDb(async d => {
    await d.run(CREATE_LOOKUPS_TABLE);
  });

const buildDeps = (
  db: SqliteDb | null,
  overrides: Partial<LookupHistoryDeps> = {},
): LookupHistoryDeps => ({
  db,
  comm: {
    getCurrentFilePath: jest.fn(async () => ok('/storage/emulated/0/Document/Dune.epub')),
    getCurrentPageNum: jest.fn(async () => ok(3)),
  },
  doc: {getCurrentDocText: jest.fn(async () => ok(PAGE))},
  logger: {log: jest.fn(), warn: jest.fn(), error: jest.fn()},
  now: () => '2026-10-06T12:00:00.000Z',
  ...overrides,
});

const rows = (db: SqliteDb) =>
  db.query('SELECT word, usage, book, timestamp FROM lookups');

describe('sentenceAround', () => {
  it('returns the whitespace-collapsed sentence containing the word', () => {
    expect(sentenceAround(PAGE, 'jeer')).toBe('The crowd began to jeer at the speaker!');
  });

  it('handles the first and last sentence of the page', () => {
    expect(sentenceAround(PAGE, 'dark')).toBe('It was a dark night.');
    expect(sentenceAround('No full stop here', 'stop')).toBe('No full stop here');
  });

  it('matches a multi-word selection across a line break', () => {
    expect(sentenceAround(PAGE, 'jeer at the')).toBe(
      'The crowd began to jeer at the speaker!',
    );
  });

  it('caps unpunctuated context on both sides', () => {
    const long = `${'a '.repeat(200)}word${' b'.repeat(200)}`;
    const s = sentenceAround(long, 'word') as string;
    expect(s).toContain('word');
    expect(s.length).toBeLessThanOrEqual(2 * 150 + 'word'.length);
  });

  it('returns null when the word is not on the page or empty', () => {
    expect(sentenceAround(PAGE, 'absent')).toBeNull();
    expect(sentenceAround(PAGE, '  ')).toBeNull();
  });
});

describe('recordLookup', () => {
  it('stores word, usage sentence, book file name and timestamp', async () => {
    const db = await historyDb();
    const deps = buildDeps(db);
    await recordLookup(deps, 'jeer');
    expect(deps.doc.getCurrentDocText).toHaveBeenCalledWith(3);
    expect(await rows(db)).toEqual([
      {
        word: 'jeer',
        usage: 'The crowd began to jeer at the speaker!',
        book: 'Dune.epub',
        timestamp: '2026-10-06T12:00:00.000Z',
      },
    ]);
  });

  it('degrades missing context to NULL instead of dropping the lookup', async () => {
    const db = await historyDb();
    await recordLookup(
      buildDeps(db, {
        comm: {
          getCurrentFilePath: jest.fn(async () => fail('no file')),
          getCurrentPageNum: jest.fn(async () => {
            throw new Error('boom');
          }),
        },
      }),
      'jeer',
    );
    expect(await rows(db)).toEqual([
      {word: 'jeer', usage: null, book: null, timestamp: '2026-10-06T12:00:00.000Z'},
    ]);
  });

  it('stores NULL usage when the page text fails or lacks the word', async () => {
    const db = await historyDb();
    await recordLookup(
      buildDeps(db, {doc: {getCurrentDocText: jest.fn(async () => fail('x'))}}),
      'jeer',
    );
    await recordLookup(buildDeps(db), 'absent');
    expect((await rows(db)).map(r => r.usage)).toEqual([null, null]);
  });

  it('is a no-op without a user.db', async () => {
    const deps = buildDeps(null);
    await expect(recordLookup(deps, 'jeer')).resolves.toBeUndefined();
    expect(deps.comm.getCurrentFilePath).not.toHaveBeenCalled();
  });

  it('never rejects: a failed INSERT only logs a warning', async () => {
    const broken: SqliteDb = {
      query: jest.fn(),
      run: jest.fn(async () => {
        throw new Error('disk full');
      }),
      transaction: jest.fn(),
      close: jest.fn(),
    };
    const deps = buildDeps(broken);
    await expect(recordLookup(deps, 'jeer')).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );
  });

  it('uses an ISO timestamp by default', async () => {
    const db = await historyDb();
    await recordLookup({...buildDeps(db), now: undefined}, 'jeer');
    const [row] = await rows(db);
    expect(String(row.timestamp)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});
