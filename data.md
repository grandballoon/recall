# Recall — data shapes

The plugin keeps three things, in three places, for three reasons.

| What | Where | Why there |
| --- | --- | --- |
| Checks | `<vault>/.obsidian/plugins/recall/checks/<hash>.json`, one per note | A write touches one note, a bad file costs one note, loading is lazy |
| Settings | `<vault>/.obsidian/plugins/recall/data.json` | Obsidian's own `loadData` / `saveData`; it syncs, which is right for preferences |
| API key | `~/.config/recall/key` (`%APPDATA%\recall\key` on Windows), mode `0600` | Outside the vault, so it never syncs and never lands in a vault backup |

The notes themselves are never written by the plugin.

TypeScript shapes are quoted from the source; the source is authoritative where they differ.

---

## A note's checks

Defined in [src/store/format.ts](src/store/format.ts).

### File name

The file name is the 64-bit FNV-1a hash of the note's vault path, as 16 hex digits plus `.json`.
No index is kept in step with it.
The file also carries the path, so a hash collision is detected rather than serving one note another note's checks.

### `NoteFile`

```ts
interface NoteFile {
  v: 1;                 // FORMAT_VERSION; any other value is unreadable
  path: string;         // the note's vault path; must match the one asked for
  deleted?: true;       // the note was deleted; checks kept until a prune
  checks: StoredCheck[];
}
```

### `StoredCheck`

```ts
interface StoredCheck {
  id: string;
  from: number;           // offsets into the note, kept current while it is open
  to: number;             // from === to means no span (a question about the note, or a follow-up)
  quote: string;          // the span's text, used to re-anchor when offsets no longer fit
  verdict: 'wrong' | 'imprecise' | 'missing' | 'solid' | null;  // null: in flight, failed, demo, or a question
  body: string;           // the note Claude returned, or a placeholder
  parentId: string | null;// the check this one hangs off, or null for the note itself
  unanchored?: boolean;   // an edit deleted the span and the quote has not put it back
  question?: string;      // what the reader asked; present means this is a question
  failed?: boolean;       // a question whose body is a placeholder or an error
  resolved?: boolean;     // dealt with: record kept, highlight removed
}
```

When `parentId` is set, `from` / `to` address the parent's `body` string rather than the note.

Derived readings, each defined once:

- `hasSpan` — `from < to`.
- `isQuestion` — `question !== undefined`.
- `isFollowUp` — has a parent, is a question, and has no span: the next line of the thread rather than a branch off part of it.
- `isAnswered` — `body` is something Claude actually said: non-empty, and either a question that did not fail or a check with a verdict. Only answered cards are replayed into a conversation.

### Reading

`parseNoteFile` returns one of three results:

```ts
type ReadResult =
  | { kind: 'ok'; file: NoteFile }
  | { kind: 'empty' }                       // nothing saved yet: the only case that may lead to a write
  | { kind: 'unreadable'; why: string };    // never written over; `why` is shown in the leaf
```

A file is unreadable if it is not JSON, is not an object, has another format version, lacks a path or names another note, or holds something that is not shaped like a check.

Additive optional fields keep the format at `v: 1`.
A change that an older build would misread bumps it.

---

## Settings

Defined in [src/settings/settings.ts](src/settings/settings.ts).

```ts
interface RecallSettings {
  model: string;                           // one of MODELS in src/checker/protocol.ts; default 'claude-opus-5'
  effort: 'high' | 'medium' | 'low' | null;// null sends no effort, the API's own default
  demoMode: boolean;                       // placeholder cards, no requests
}
```

`normaliseSettings` runs on every read, because `data.json` is a file the reader can edit.
An unknown model falls back to the default rather than failing every check with a 404 that reads like a key problem.

---

## The key file

Defined in [src/key/keyfile.ts](src/key/keyfile.ts).

One line: the key with all whitespace removed, followed by a newline.
The folder is created `0700` and the file written `0600`.
Settings show the path, which is not a secret, and only whether a key is present.

---

## The wire

Defined in [src/checker/protocol.ts](src/checker/protocol.ts).

A check sends the note text, without frontmatter, as a cache-controlled prefix, then the span.
The reply is constrained by a JSON schema to:

```ts
{ verdict: 'wrong' | 'imprecise' | 'missing' | 'solid'; note: string }
```

A question sends the same prefix, then the thread as alternating turns, and gets plain prose back.
Checks and questions have different system prompts, so they never share a cache entry.

---

## The artifact

The frozen artifact keeps its own library document, a single JSON envelope saved through `claudeArtifact.publish` to `data/library.json` and read back from the `#recall-data` script tag.
Its shape is defined only by `artifact/index.html`; the version of this file from before 2026-10-26 (`git show 9a46976:data.md`) describes it.
Nothing in the plugin reads or writes it.
