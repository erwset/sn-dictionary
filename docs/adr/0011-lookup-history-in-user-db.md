# ADR-0011: Lookup history in user.db (Kindle Vocabulary Builder parity)

- Status: proposed
- Date: 2026-10-06
- Relates to / refines: ADR-0001 (SQLite unblocks "future history"), ADR-0009 (additive user.db tables, graceful degrade)

## Context and Problem Statement

Kindle readers rely on the Vocabulary Builder: every dictionary lookup lands in `vocab.db` with the sentence it came from, and people export that into flashcard tools (Anki etc.). The plugin shows definitions but forgets them — there is no way to review what was looked up while reading.

## Decision

Record every **DOC** lookup into an additive `lookups` table in **user.db**:

`lookups (word TEXT NOT NULL, usage TEXT, book TEXT, timestamp TEXT NOT NULL)`

- `word` — the trimmed selection (what was looked up, hit or miss).
- `usage` — the sentence around the selection, cut from `PluginDocAPI.getCurrentDocText(page)`. The SDK exposes no selection offset, so the first occurrence on the page wins.
- `book` — the document file name (`PluginCommAPI.getCurrentFilePath`).
- `timestamp` — ISO-8601, like `entries.created_at`.

`recordLookup` is **best-effort and never rejects**: each missing context piece is stored as NULL, a failed INSERT only logs, and a null user.db is a no-op. The DOC handler fires it **after** the final `showResult` without awaiting it, so the popup and the reentrancy guard are untouched. The table is created in bootstrap's degradable user.db block next to the ADR-0009 tables.

Getting the data off the device needs no new code: Settings → Export already copies (and checkpoints) user.db into `MyStyle/`.

## Considered Options

- **Separate `history.db`.** Rejected: the export set is base + user + imports, so a new DB would need export/restore wiring.
- **Clone Kindle's schema (`WORDS` / `LOOKUPS` / `BOOK_INFO`).** Rejected: three tables and joins for a log that one flat table holds.
- **Also record NOTE (lasso) lookups.** Deferred: handwriting has no surrounding text short of OCR-ing the whole page, so the row would carry no `usage`.
- **A Settings toggle.** Deferred: rows are tiny and stay on the device; a toggle touches the panel, i18n (7 locales), and tests. It can be added if users ask.

## Consequences

- user.db grows by one small row per DOC lookup. Nothing prunes it; users can delete rows from an exported copy.
- An empty `usage` on device means the page index passed to `getCurrentDocText` didn't match the page that holds the selection.
