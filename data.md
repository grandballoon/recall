# Recall — data shapes

Recall has no schema file and no typed frontend.
The shapes below are the ones the code actually relies on, read out of the source and written down in one place.

Two rules explain most of the layout.

First, **the library's shape lives entirely in the webview**.
Rust treats the saved library as an opaque string: `library.rs` moves bytes to and from disk and never parses them, so the store does not change when the document model does.
Every type in [The library document](#the-library-document) is therefore defined only by the JavaScript that writes it.

Second, **the two surfaces share one document model but differ at the edges**.
The Claude artifact ([artifact/index.html](artifact/index.html)) and the Tauri desktop app ([src/index.html](src/index.html) + [src-tauri/](src-tauri/)) serialize the same envelope; they differ in where it is written, how the AI check is called, and what a failed check records.
Divergences are called out inline.

TypeScript notation is used for the JavaScript shapes because they are untyped in the source; Rust shapes are quoted as they are declared.

---

## The library document

This is the only durable document in the product.
It is serialized whole on every save — one JSON string, no partial writes, no per-entry files.

- Desktop: `library.json` in the app data directory, via the `library_save` / `library_load` commands.
- Artifact: `data/library.json`, via `claudeArtifact.publish(...)`, read back from the `#recall-data` script tag the server embeds into the served page.

### Envelope

```ts
type LibraryFile = {
  v: 1;                    // format version; anything else is refused, never migrated
  library: Entry[];
  activeId: string | null; // id of the entry on the desk at save time
  libView: 'shelf' | 'stepper' | 'landing';
  libVisible: boolean;
};
```

`v` is a hard gate rather than a hint.
The desktop app refuses any value but `1` and enters safe mode ([src/index.html:1421](src/index.html#L1421)); the artifact simply declines to hydrate ([artifact/index.html:1218](artifact/index.html#L1218)).
There is no migration path in the code, so bumping `v` is a breaking change that must ship with one.

`libView` is persisted and read back, but only `'shelf'` is implemented in the renderer; the other two are reserved names.

### Entry

```ts
type Entry = {
  id: string;                        // 'entry' + 7 random base-36 chars
  title: string;                     // user-editable; '' falls back to prompt.slice(0, 40)
  prompt: string;                    // the question being answered from memory
  editorHTML: string;                // the writing surface's innerHTML — see below
  comments: Record<string, Comment>; // id -> Comment, for this entry only
  order: string[];                   // TOP-LEVEL comment ids, in creation order
  seq: number;                       // per-entry id counter; next comment is 'c' + seq++
  source: string;                    // always '' — reserved, never read or written after creation
  updatedAt: number;                 // epoch ms, stamped on every persist()
};
```

`editorHTML` is not plain prose: it is contenteditable HTML, and it is where the highlight anchors live.
A checked span is a **set** of `<mark class="hl note" data-comment-id="c3" data-len="42">` elements sharing one comment id — one per block the span covers, since a selection crossing a paragraph boundary cannot be wrapped in a single element.
A span within one paragraph is still a single mark, which is the common case, but nothing may assume it.
That means the link between a comment and the text it grades is stored **as markup inside the entry's HTML**, not as an offset pair — moving to offsets would be a document-model change, not a rendering change.

The exception is a question asked about a comment card rather than about the prose: that markup is rebuilt from scratch on every render, so it cannot hold an anchor, and those carry `anchor` offsets instead (see [Comment](#comment)).

`data-len` is the tracked character length of the span, maintained by `fixHighlightBoundary` so that text typed off the end of a highlight gets popped back out instead of silently joining it ([src/index.html:1459](src/index.html#L1459)).
It is refreshed on every input event inside a mark, and rebuilt on load for any mark that lacks it.

`anchor` is character offsets into the parent card's rendered text, and is present only on questions asked about a comment.
Prose anchors need no such field: they are the marks themselves.
It is additive, so libraries written before it read back unchanged and the envelope stays `v: 1`.
A question saved before the field existed is located by searching the rebuilt card text for its `quote`.

`order` holds top-level ids only.
Replies (comments whose `parentId` is set) live in `comments` but appear in no index, so the unresolved count and the rail badge count top-level threads only.

### Comment

```ts
type Comment = {
  id: string;                  // 'c' + entry.seq
  quote: string;               // the exact highlighted text, captured at ask time
  verdict: Verdict | null;     // null = not assessed
  body: string | null;         // the note, or an error explanation
  parentId: string | null;     // set when questioning a span of another comment
  targetKind: 'prose' | 'comment';
  anchor?: { start: number; end: number } | null;  // set only when targetKind is 'comment'
  pending?: boolean;           // true between ask and answer; persisted if a save lands mid-check
  resolved?: boolean;          // absent until 'Mark resolved'; never set back to false
};

type Verdict = 'wrong' | 'imprecise' | 'missing' | 'solid';
```

`Verdict` is closed and shared by all three layers: the JSON-schema constraint on the API request, the Rust enum, and the label map in the renderer.
The four wire strings appear in [src-tauri/src/claude.rs:75-82](src-tauri/src/claude.rs#L75-L82) as a `#[serde(rename_all = "lowercase")]` enum, and are mapped to display labels — `Incorrect`, `Imprecise`, `Incomplete`, `Solid` — at [src/index.html:1062](src/index.html#L1062).
Adding a fifth verdict means touching the schema in the request builder, the enum, its round-trip test, and that label map.

`verdict: null` is meaningful, not missing data.
On desktop, a failed or unavailable check stores `null` on purpose: the span was never assessed, so labelling the writing would misreport what happened ([src/index.html:940-950](src/index.html#L940-L950)).
The artifact does not do this — it coerces an unrecognized verdict to `'imprecise'` and labels failures `'imprecise'` too ([artifact/index.html:837-846](artifact/index.html#L837-L846)) — so libraries written there can contain verdicts that were never actually a model's judgment.
This is the one substantive divergence in the document model between the two surfaces.

`resolved` is one-way.
`markResolved` sets it to `true`, unwraps every `<mark>` the span holds from `editorHTML`, and drops the id from the live card path; nothing sets it back.
A dismissed comment is different: `removeComment` unwraps the marks and deletes the record outright, so dismissal leaves no trace in the document.

Replies carry `parentId` but no `children` index — the ancestor chain is reconstructed by walking `parentId` upward ([src/index.html:975-985](src/index.html#L975-L985)).
The highlight anchoring a reply sits inside a rendered card body, and card bodies are rebuilt from `comment.body` on every render, so it cannot survive as markup.
It is re-wrapped from the reply's `anchor` offsets each time the parent card is drawn; a reply saved before that field existed is located by searching the rebuilt text for its `quote`.

---

## Session state (not persisted)

`state` is the live desk.
Its `comments` / `order` / `seq` fields are **mirrors of the active entry**, not a second source of truth: `syncActiveEntry()` writes them back into the `Entry` before every serialize, and `loadEntry()` swaps them when the active entry changes.

```ts
const state: {
  comments: Record<string, Comment>;  // mirror of activeEntry.comments
  order: string[];                    // mirror of activeEntry.order
  seq: number;                        // mirror of activeEntry.seq
  stackPath: string[];                // ancestor chain, top-level -> deepest visited card
  cursor: number;                     // index into stackPath of the card in view
  library: Entry[];
  activeId: string | null;
  libView: 'shelf' | 'stepper' | 'landing';
  libVisible: boolean;
};
```

`stackPath` and `cursor` are pure view state — the comment-wing card stack — and are the only two fields in `state` that are never serialized.

Other session-only values:

```ts
const connection: { connected: boolean; model: string | null };  // never holds the key itself
let backendPersist: boolean;   // desktop: false outside the app, or in safe mode
let claudeSample:  object|null; // artifact: the 'sample' capability, if granted
let claudeArtifact: object|null;// artifact: the 'artifact' capability, if granted

// captured on selectionchange, consumed when 'Ask' is clicked
let pendingContext: {
  quote: string;
  kind: 'prose' | 'comment';
  parentCardId: string | null;
  fullText: string;   // editor.innerText, or the card body's innerText
} | null;

// what runCheck() reduces every path — real, demo, or failed — down to
type CheckResult = { verdict: Verdict | null; body: string };
```

### Hydration result

Why a load failed decides what happens next, so it is a typed result rather than a boolean ([src/index.html:1407-1429](src/index.html#L1407-L1429)).

```ts
type HydrateResult =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'unreadable' | 'version'; detail?: string };
```

Only `'empty'` — nothing saved yet — permits seeding a first entry.
`'unreadable'` and `'version'` mean a library exists on disk that could not be used, so the app enters safe mode: persistence off for the session, undismissable banner, and a button that reveals the file and its `.bak` in Finder.
The artifact's equivalent (`hydrateFromData`) returns a bare boolean, because there is no destructive-overwrite risk to guard against.

---

## The IPC boundary (desktop)

Every call crosses through [src/claude.js](src/claude.js); the rest of the page never touches Tauri directly.

Argument names are **camelCase** on the JS side and are converted by Tauri to the Rust parameter's snake_case (`apiKey` → `api_key`, `fullText` → `full_text`).
Returned structs are **not** converted: no `#[serde(rename_all)]` is applied to them, so `FileEntry.modified_ms` reaches JavaScript with that exact spelling.

| Command | Args | Returns |
| --- | --- | --- |
| `claude_status` | — | `Status` |
| `claude_connect` | `{ apiKey: string }` | `Status` |
| `claude_disconnect` | — | `Status` |
| `claude_assess` | `{ fullText: string, span: string }` | `Assessment` |
| `library_load` | — | `string \| null` |
| `library_save` | `{ data: string }` | `null` |
| `library_reveal` | — | `null` |
| `files_folder` | — | `string` (absolute path) |
| `files_folder_pick` | — | `string \| null` (null = cancelled) |
| `files_list` | — | `FileEntry[]`, newest first |
| `files_import` | — | `string[]` (names as landed) |
| `files_open` | `{ name: string }` | `null` |
| `files_reveal` | — | `null` |
| `files_delete` | `{ name: string }` | `null` |

```rust
#[derive(serde::Serialize)]
pub struct Status {
    pub connected: bool,
    pub model: &'static str,   // always claude::MODEL — "claude-opus-5"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Assessment {
    pub verdict: Verdict,
    pub note: String,
}

#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    size: u64,
    modified_ms: u64,   // epoch ms; 0 when the filesystem gives no mtime
}
```

`Status` is the only channel through which the webview learns anything about the key.
It reports *whether* one is stored and which model checks run on — never the key itself, which stays in the OS keychain and crosses only into Rust.

### Error

Every rejected call — Rust or the JS bridge — rejects with the same two-field shape.

```rust
#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,  // stable; safe to branch on
    pub message: String,     // for the reader
}
```

`code` is the contract; `message` is prose and must not be matched against.
The full set in use:

| `code` | Raised by | What the UI does |
| --- | --- | --- |
| `not_connected` | no key in the keychain | falls back to demo feedback |
| `unavailable` | the JS bridge, when `window.__TAURI__` is absent | demo feedback; turns persistence off |
| `auth` | 401/403, or an empty key at connect | surfaces in the settings status line |
| `no_model_access` | 404 — key works, model unreachable | surfaces in the settings status line |
| `rate_limited` | 429 | shown on the card, verdict left null |
| `overloaded` | 500/529 | shown on the card, verdict left null |
| `network` | transport failure or the 120s timeout | shown on the card, verdict left null |
| `refusal` | `stop_reason: "refusal"` | shown on the card, verdict left null |
| `malformed` | truncated, absent, or unparseable answer | shown on the card, verdict left null |
| `api` | any other non-2xx | shown on the card, verdict left null |
| `keychain` | the OS credential store is unreachable | surfaces in the settings status line |
| `store` | any filesystem or path failure | toast, or safe mode at boot |

The artifact surface has its own set, coming from `window.claude` rather than from this struct: `not_granted` and `sampling_disabled` on the sample capability, and `not_writer`, `not_granted`, `capability_disabled`, `conflict` on publish.

---

## Wire shapes

### Anthropic Messages API (desktop)

Built in `assess_request` ([src-tauri/src/claude.rs:159](src-tauri/src/claude.rs#L159)) and pinned by test, so it is a contract rather than an implementation detail.

```jsonc
{
  "model": "claude-opus-5",
  "max_tokens": 16000,
  "system": "<the tutor framing>",
  "thinking": { "type": "adaptive" },
  "fallbacks": "default",              // paired with the server-side-fallback beta header
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "verdict": { "type": "string", "enum": ["wrong","imprecise","missing","solid"] },
          "note":    { "type": "string" }
        },
        "required": ["verdict", "note"],
        "additionalProperties": false
      }
    }
  },
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Their full explanation:\n\n<explanation>…</explanation>",
        "cache_control": { "type": "ephemeral" } },   // breakpoint: the page, whole and uncut
      { "type": "text", "text": "The highlighted span to assess:\n\n<span>…</span>" }
    ]
  }]
}
```

The schema block is the source of truth for `Verdict` on the wire, and the response text parses directly into `Assessment`.
The page is sent whole and carries the cache breakpoint, so checking several spans of one unedited page replays the prefix from cache.

The response is read through a narrow deserializer that ignores everything it does not need:

```rust
struct MessageResponse {
    content: Vec<ContentBlock>,
    stop_reason: Option<String>,   // "refusal" and "max_tokens" are handled before parsing
}

#[serde(tag = "type")]
enum ContentBlock {
    #[serde(rename = "text")] Text { text: String },
    #[serde(other)] Other,        // thinking and fallback blocks precede the answer
}
```

The answer must be *found* rather than indexed, because thinking blocks (and, on a rescued refusal, a fallback block) come first.

### `window.claude` sample (artifact)

The artifact has no typed output constraint.
It asks for JSON in the prompt, calls `claudeSample.json(prompt, { modelTier: 'default' })`, and validates the verdict against the same four strings on the way out — coercing anything else to `'imprecise'`.
It also truncates the page at 4000 characters (`fullText.slice(0, 4000)`), where the desktop path sends it whole.

---

## Files on disk

### App data directory (desktop)

| File | Shape | Written by |
| --- | --- | --- |
| `library.json` | the `LibraryFile` envelope, serialized | `library_save`, atomically |
| `library.json.bak` | the previous `library.json`, verbatim | rotated by rename on every save |
| `library.json.tmp` | transient; renamed into place, never left behind | `save_to` |
| `config.json` | `{ "filesDir": string }` | `files_folder_pick` |
| `config.json.tmp` | transient | `write_configured_folder` |

`config.json` is the one small exception to "Rust never parses app data": `files.rs` reads a single string field out of it and ignores the rest.
A missing or empty `filesDir` falls back to `~/Documents/Recall`.

### Files folder

A flat directory of source material — a paper, notes, a reference summary — surfaced as `FileEntry[]`.
It is a shared shelf, not per-entry storage: nothing associates a file with an `Entry`, and `Entry.source` (always `''`) is not that association either.
Names crossing the IPC boundary are constrained to a single path component — no `/`, no `\`, no leading `.`, exactly one component — so nothing outside the folder can be read or written ([src-tauri/src/files.rs:95](src-tauri/src/files.rs#L95)).
Import collisions are resolved by suffix: `note.md`, then `note (2).md`.

### OS credential store

One record, and the only place the API key exists.

| Field | Value |
| --- | --- |
| service | `com.grandballoon.recall` |
| account | `anthropic-api-key` |
| secret | the raw Anthropic API key |

Keychain access is granted by code signature, which is why a stable Developer ID signature matters: an ad-hoc signature changes every build and the stored key stops being reachable.

### localStorage

One key, on both surfaces, holding a UI preference only — never document content.

| Key | Value |
| --- | --- |
| `recall.commentsSide` | `'left' \| 'right'` |

---

## DOM-encoded state

Some state is expressed as attributes rather than objects.
Only the first two below are durable — they are part of `editorHTML` and therefore part of the saved document.

| Attribute | On | Meaning |
| --- | --- | --- |
| `data-comment-id` | `mark.hl` | **persisted** — links a highlighted span to its `Comment` |
| `data-len` | `mark.hl` | **persisted** — tracked span length, guards the trailing edge |
| `data-comment-id` | `.card` | the card's comment, in the live stack |
| `data-entry-id` | `.lib-item` | the shelf row's entry |
| `data-view` | `#library` | mirrors `state.libView` |
| `data-lib` | `#shell` | `'shown' \| 'hidden'`, mirrors `state.libVisible` |
| `data-comments-side` | `#shell` | `'left' \| 'right'`, mirrors `recall.commentsSide` |
| `data-count` | `.railNotes` | unresolved top-level comments on the active entry |
| `data-n` | `.it-dot` | same count, per shelf row |

---

## Invariants worth keeping

Each of these is relied on somewhere and would break quietly if violated.

Comment ids are unique **per entry**, not globally — `seq` is an `Entry` field, so two entries both contain a `c1`.
Any future cross-entry index has to key on `(entryId, commentId)`.

`state.comments` / `order` / `seq` must be synced back into the active `Entry` before any read of `state.library`.
`serializeLibrary()` and `loadEntry()` both call `syncActiveEntry()` first for exactly this reason; a new code path that serializes without it will silently drop the current entry's edits.

A `Comment` in `comments` with a `data-comment-id` mark missing from `editorHTML` is a resolved comment, and that is a normal state.
The reverse — a mark whose id is absent from `comments` — is corruption, and nothing currently detects it.

`v` must never be bumped without a migration, because an unrecognized version now means safe mode for every existing library on first launch of the new build.

The whole library is rewritten on every save, so the `.bak` rotation is the only thing standing between one bad write and the loss of the entire history.
