# Recall as an Obsidian plugin — what it would take

_Scoped against the live surfaces (`artifact/index.html`, `src/` + `src-tauri/`) on 2026-09-15._

A third surface: highlight a span in a note, hit a hotkey, get a typed verdict back, keep it, read it in a side leaf.
Same product, but almost none of the same plumbing — the parts of Recall that are hardest to get right are exactly the parts Obsidian either gives away or forbids.

## Carries over unchanged

The checker itself.
`src-tauri/src/claude.rs` is a self-contained "explanation + span → `{verdict, note}`" boundary: system prompt, the four verdicts, `claude-opus-5`, the JSON-schema constraint, the refusal fallback, and the whole-page prefix cache.
That becomes a TypeScript module calling `requestUrl()` from the Obsidian API, which runs outside the renderer and so sidesteps CORS on `api.anthropic.com` entirely.
Demo-mode fallback and the deliberate blank verdict on a failed check port as-is.

The one field it needs that a note does not have is the prompt.
An optional `recall-prompt` frontmatter key carries it where the user wants one, and the note title stands in where they do not.
Keeping it in frontmatter rather than in our own data means it survives a rename, travels with the note, and stays visible to the person writing.

The verdict palette ports as CSS.
`--v-<verdict>-{wash,line,ink,on}` moves to `styles.css`, redefined under `.theme-dark`, and keyed to Obsidian's own `--background-*` / `--text-*` variables so it survives community themes.

## Must be rebuilt

**Anchoring.**
This is the port.
Obsidian's editor is CodeMirror 6, not `contenteditable`, so `markRange`, `unwrapMarks`, `<mark>` sets, the empty-mark repair, and the plain-text paste guard all go — you cannot write DOM into a CM6 document.
Highlights become `Decoration.mark` ranges in a `StateField`, registered via `registerEditorExtension`.

That trade is strongly in our favour.
A CM6 decoration set is mapped through `tr.changes` on every edit, so a highlight follows its text as the user types above it, and a span that gets deleted takes its decoration with it.
The entire class of defect the last few commits fought — lost highlights, orphaned checks, the quote-rematch repair notice — is handled by the framework.
Keep `findQuote` only as the reload path, for anchors whose stored offsets no longer match.

Decorations are an editor construct, so a note read in Reading mode shows no highlights and no way to reach a check from the prose.
That is accepted — Recall is an editing-mode feature, and we are not building a second rendering path for it.
The consequence to design around is that the leaf becomes the only entry point to a note's checks whenever that note is not being edited.

None of this reaches for `editor.cm`, the undocumented handle most plugins use to get at the CM6 view.
It is not needed: `registerEditorExtension` is documented, and an extension is *handed* its own view, so views can register themselves with us instead of us reaching into leaves to find them.
`editorInfoField` (exported from `obsidian`) tells each one which file it belongs to.
Everything the leaf needs in the other direction — `offsetToPos`, `setSelection`, `scrollIntoView` — is on the documented `Editor`.
So the port stands entirely on public API, which is the whole of its exposure to an API change.

**Where checks live.**
A comment tree keyed to a vault path, holding `{from, to}` offsets plus the quote, in one file per note under the plugin folder rather than in `data.json` — see *Persistence* below for why `saveData` is the wrong shape for this.
The source note stays clean markdown — no `==marks==`, no frontmatter payload — which is the whole reason to be in Obsidian.
Rewrite the offsets on every editor change so a note edited with the leaf closed still resolves.

**How a check is asked for.**
The floating pill does not port.
A selection is checked from the editor context menu (`editor-menu`) or from a command with a stable id, which is the native idiom, keeps anything from floating over CM6, and behaves the same under every community theme.
The command id is also what phase-2 hotkeys bind to, so it wants to be right the first time.

**The comment UI.**
An `ItemView` registered as a right-side leaf, opened by command, listing the active note's checks; clicking one scrolls to and selects its span.
One leaf that retargets as you move between notes, the way Outline and Backlinks do — a pattern users already have, and one that gets per-note pinning for free from Obsidian's own leaf pin rather than from us.
Checks that could not be re-anchored surface as a section at the top of that leaf: persistent, ignorable, and still moving nothing until asked, which is the current behaviour with a new address.
Where the note is open in Reading mode there is no span to reach, so the card shows in the leaf with a "reveal in editor" action on it — clicking always does something, and changing someone's view mode stays their call.
A canvas, a PDF, or an image in the active tab gets the leaf's empty state and nothing else; those files are not a target, and treating them as an absence of checks is both true and free.
The margin-comment layout does not survive — a leaf is a panel, not a gutter.
Breadcrumbs, the card stack, and threads on threads can move over intact; the left/right side preference and its `localStorage` entry cannot, because the user drags leaves where they want them.

The shape stays ours, and it is a shape Obsidian plugins already prove out: one main writing surface with the panels to one side.
What changes is the mechanism — a leaf rather than a margin — not the layout the reader sees.
Nested leaves are out of scope; depth in a thread stays inside the single leaf, as the card stack it already is.
The port stays a third surface of this repo, and `spec.md` grows a section for it rather than the port carrying a spec of its own.

## Dissolves

The vault is the library.
Entries, the shelf, rename, seeding, `library.json`, the `.bak` rotation, safe mode, and the files-folder wing (`files.rs`, both Tauri plugins) all delete.
That is most of `src-tauri/` and a large share of `src/index.html`.

## Regresses

The API key.
The spec's hard constraint — the key lives in the OS keychain and never enters the webview — cannot hold.
A plugin *is* the renderer, so the key is in the webview whatever we do; Obsidian has no secret store to borrow instead.
What is still ours to protect is the vault: `data.json` sits inside it and rides Obsidian Sync to every device in plaintext, which is a worse regression than the one we are forced into.

So the key lives in a file **outside** the vault, at one fixed path — `~/.config/recall/key` or the platform equivalent — written by the plugin when the user pastes a key into settings and read back through `FileSystemAdapter`.
It never enters the vault, never syncs, and costs no daemon.
One fixed path rather than a configurable one is deliberate: a plugin that reads and writes outside the vault has to justify itself at review, and "one file, this path, the key you pasted" is a story that survives that conversation where an arbitrary user-supplied path does not.
The price is that there is no key to read on mobile, which is the next decision rather than an accident of this one.

## Build

`manifest.json` + esbuild to a single `main.js`, `obsidian` / `electron` / `@codemirror/*` external, installed to `.obsidian/plugins/recall/`.
`npm run build` emits it, `npm run dev` watches, `npm run check` typechecks, `npm test` runs the suite.
Node 20.17 or newer: the npm that ships with the repo's older Node refuses to run at all, which is a confusing first five minutes otherwise.
`requestUrl` and CM6 both work on mobile, and with the key outside the vault there is nothing for a phone to read, so mobile could only ever be read-only: highlights render, the leaf opens, existing checks are legible, and asking for a new one is unavailable.
That falls out of the architecture rather than needing to be built.
`isDesktopOnly` is nevertheless **true**, taking the second of the two options this section used to leave open: nobody has looked at the leaf at phone width, and shipping a layout nobody has looked at is worse than saying so.
The read-only path is written and costs nothing to keep, so flipping the flag back is a phone and an afternoon rather than a rewrite.
Node builtins (`fs`, `os`) are external and reached through `require` inside a try/catch, so the bundle still loads where they are absent.

This is headed for the community plugin list, though not with the first cut.
Writing to the review guidelines from the start was much cheaper than retrofitting them, and the built bundle now holds none of what they prohibit: no `innerHTML`, `outerHTML` or `insertAdjacentHTML`, no `editor.cm`, no global `app`, one declared network host, and every command unbound.
The card stack, breadcrumbs, card body and verdict slot — the `innerHTML` sites that were going to survive the port — are `createEl` instead, and the rest went with the editor, the library and the files wing.

## Order

Checker module → decoration field → persistence → leaf → settings.
The first three are the risk; after that it is the existing UI, minus a third of it.

The checker module has landed: `src/checker/protocol.ts` holds the wire contract as pure functions, `src/checker/index.ts` is the transport over `requestUrl`, and the Rust suite it was ported from is reproduced against the TypeScript.

So has the decoration field.
`src/anchor/field.ts` is the `StateField` and its effects, `src/anchor/anchoring.ts` is the quote re-anchor for offsets that no longer fit, `src/anchor/registry.ts` is the self-registering view plugin, and `styles.css` carries the verdict palette over.
And so has persistence.
`src/store/format.ts` is the on-disk shape and the read that reports *why* it failed, `src/store/store.ts` is one file per note over an injected adapter — Obsidian's `DataAdapter` satisfies it, and `main.ts` is the only file that knows that.

The leaf has landed too, along with the join the first three stages were missing.
`src/session/session.ts` is that join, and it is the only thing that knows about both halves: it loads a note's checks, puts each one back on its span, broadcasts the result to every editor showing that note, keeps the stored offsets current as the text moves, and writes the result back.
Nothing in it imports `obsidian` — the broadcast goes through an interface `ViewRegistry` happens to satisfy — so it runs headless against a real CM6 document with a `Map` for a disk.
`src/leaf/view.ts` is the `ItemView` and `src/leaf/card.ts` is one check as a card, both built with `createEl` rather than `innerHTML`.
`src/check/outcome.ts` holds what a card says when the answer is not an assessment.

Asking for a check landed with it, because a leaf that can never show one cannot be judged.
The selection is checked from the editor context menu or from `check-selection`, and with no key yet every check takes the demo path — which is the same path a reader without a key takes once settings exist.
That makes the whole stage exercisable in a scratch vault without spending a token.

97 assertions across the four stages, all headless.
CM6 runs in Node without a DOM, so the editor state under test is real and only the rendering is absent; the store's disk is a `Map`.
`src/main.ts` registers the editor extension, the leaf, the vault listeners, and the four commands.

Settings landed last, which is what makes the plugin do its job rather than demonstrate it.
`src/key/keyfile.ts` is the key at one fixed path outside the vault, written `0600`, with the path arithmetic and the read rules asserted against a fake filesystem.
`src/settings/settings.ts` is what the reader can change and `src/settings/tab.ts` is the tab that renders it — the same pure/Obsidian split as the checker, and the test build enforces it by refusing to resolve `obsidian`.
A key is verified against the chosen model before it is stored, which costs no tokens and turns "it silently never works" into a sentence at the moment of pasting.
Settings are normalised on read, because `data.json` is a file the reader can edit and an unknown model would fail every check with a 404 that reads like a key problem.

Nested threads landed with them.
`src/leaf/body.ts` holds the arithmetic: a card's note becomes paragraphs that remember where they start in the stored string, runs that carry their own offset, and a selection read back into `{from, to}` against that string.
A question is asked from a context menu on the card, which is the same idiom as checking a span in the editor and needs no floating layer of its own.
Depth stays inside the single leaf as a card stack with a breadcrumb trail, and a dismissed thread takes the questions hanging off it, because a question about a note whose note is gone has nothing left to mean.

141 assertions across the five stages, all headless.

Three things went in the process.
`CheckStore.markUnanchored` — the session owns that transition now and writes through the same debounced queue as everything else, and two ways to mark the same thing is two ways for them to disagree.
The hand-listed test entry points, which meant a new test file was built and run only if somebody remembered to add it.
And a data-loss bug in `prune`: a note deleted and then restored from the trash kept the `deleted` flag on its checks, so "Prune checks for deleted notes" destroyed a live note's checks and reported them as a deleted note's.
The vault now decides whether a note is gone, `vault.on('create')` clears the flag as soon as a note comes back, and a prune repairs a stale flag rather than acting on it.

## Questions

A check asks one thing — is this span right — and gets a typed verdict back.
A question asks anything, in the reader's own words, and gets prose back.
Both live in the same leaf, in the same threads, in the same per-note file, so that asking Claude something never means leaving the note for a chat window and losing the answer when it closes.

**One box, at the foot of the leaf.**
What a question is about is decided by where the reader is, not by which control they reached for.
With the list showing, it is about the note.
With a thread open, it is the next line of that thread.
With a span picked — in the editor through `ask-selection` or the context menu, or in a card through its context menu — it is about that span, and the box shows the span until the question is sent or the span is let go.
Enter breaks the line and Cmd+Enter sends (Ctrl+Enter where there is no Cmd key), so a question can run to several lines and is never sent by accident.
The box is built once and kept (`src/leaf/composer.ts`), because the cards above it are rebuilt every time an answer lands and a box rebuilt with them would lose whatever was half-typed.

**A question is a check with words on it, not a second kind of record.**
`StoredCheck` gains two optional fields: `question`, what was asked, and `failed`, set when the body is a placeholder or an error rather than an answer.
A question with no span is stored with an empty range rather than a different shape, and `hasSpan` is the one place that reads it.
So everything a check already had, a question has for free: the debounced per-note write, the refusal to overwrite an unreadable file, the cascade that removes a thread with its root, retry, and the nested highlights inside an answer.
The fields are additive and the format stays `v: 1`.

**It never colours the prose.**
A question about a span of the note is highlighted, so there is something to open it from, and the highlight stays neutral grey after the answer arrives.
That is the same rule that leaves a failed check grey: a verdict is the only thing that reports on the writing, and a question does not produce one.

**A thread is stored as a tree and sent as a line.**
`src/ask/conversation.ts` turns one into the other, and it is pure.
The line is the question's ancestors, root first, and wherever a step on it is a follow-up, the follow-ups asked before it under the same card come first — that is the conversation it was a reply in.
A question about a span of an answer is a branch rather than a reply, so it brings only its ancestors.
Each earlier card goes as an exchange: what was asked, with its span quoted and attributed to the reader's explanation or to Claude's reply, and then what Claude said.
A card whose body is a placeholder or an error is left out whole, because replaying it would put words in Claude's mouth that it never said.

**The wire shape is the check's, minus the schema.**
`askRequest` in `src/checker/protocol.ts` sends the note first, cached, with the conversation after it, so a run of follow-ups on one unedited note replays the prefix.
The system prompt is not the check's, so a question and a check on the same note do not share a cache entry — the cache key takes the system prompt in before the messages.
Answers are asked for as plain prose with no markdown, because a card renders its text as runs that keep their offsets, which is what lets any part of an answer be selected and questioned in turn.
The model and effort settings apply to questions exactly as they do to checks, and so does demo mode.

**A span picked for a question is not recorded until the question is.**
Between the two the note can be edited, so the span is put where its text now is when the question is sent — the same `resolveAnchor` a reload uses — and refused out loud if that text is gone or no longer unique.

Two commands, both unbound: `ask-selection` and `ask-note`.

164 assertions, all headless.
None of this has been run inside Obsidian either, and the leaf's layout — a scrolling region over a fixed box — is the part most worth looking at first.

## Phase 2

Hotkeys for "check the selected span."
The command exists with a stable id (`check-selection`) and is unbound, as the guidelines ask, so a binding is now a line of config on top of work already done.

## Answered

These were open a moment ago.
Where Obsidian's or CodeMirror's docs settle it, the source is named; where they do not, the call is ours and the reason is given.

### Checker module

**Error detail from `requestUrl`.**
It throws on status 400+ by default, and `throw: false` makes it resolve instead with `{status, headers, text, json, arrayBuffer}`.
So we branch on `status` ourselves exactly as `claude.rs` does, and the refusal fallback and the demo-mode trigger keep the specifics they read today.

**What we send as "the page".**
The note's document text, frontmatter stripped apart from the prompt we read out of it.
`![[transclusions]]` go as written rather than resolved: resolving them would inflate the cached prefix and invalidate it whenever an embedded note changed, for context the writer did not type.
A known limitation to revisit, not an oversight.

**The prefix cache stays.**
Checking several spans of one note in a sitting is exactly the pattern the product produces, which is what the cache was built for; moving to another note simply misses.
The hit rate is worth measuring once there is something to measure, but nothing about the vault argues for pulling it out first.

### Decoration field

**Mark inclusivity is already the behaviour we hand-built.**
`Decoration.mark`'s `inclusive` defaults to false, so text typed at either boundary falls outside the decoration.
That is what `fixHighlightBoundary` and `data-len` exist to produce, and it deletes both.

**Live Preview and Source mode agree on offsets.**
Both hold the same raw-markdown document; Live Preview only conceals and replaces through decorations of its own.
Stored `{from, to}` address that document, so they mean the same thing in either mode — what differs is what the reader sees, not where the span is.

**Undo does not bring a check back on its own.**
A deletion drops the decoration when its range collapses, and undoing that deletion re-inserts the text without resurrecting it, because the decoration is no longer in the field's value to be mapped.
The rule that follows is the important part: losing a decoration never deletes the check.
The record stays in data, and text coming back is a re-anchor by quote — the same path a reload already takes.

**One source of truth, broadcast to every view.**
`registerEditorExtension` applies to every editor, and each `EditorView` keeps its own `StateField`, so a split pane holds a second decoration set for the same file.
Plugin data is authoritative, and a new check dispatches a `StateEffect` to each view showing that file.
The views are found by having them register themselves: a `ViewPlugin` is constructed with its own view, and `editorInfoField` says which file it is on, so we keep a small registry instead of walking the workspace.
That also steps around deferred views entirely — since 1.7.2 a background tab holds a `DeferredView` with no editor to find, and a view that does not exist yet simply registers when it loads.

**Selections no longer need a refusal path.**
A CM6 selection is a document range in every case; there is no `surroundContents` to throw on a partially-selected node, which is what forced the refusal.
What remains is a guard that we do not check a span sitting inside frontmatter, which is metadata rather than writing.

**No `editor.cm`.**
The registry above removes the only reason we had to reach for it, so the undocumented surface drops out of the design rather than being isolated behind an accessor.
That is the simpler thing to build and the more stable thing to own: nothing to feature-detect, no degraded mode to write and never test, and nothing for a reviewer to ask about.
The guidelines' explicit prohibitions — `innerHTML` / `outerHTML` / `insertAdjacentHTML` and the global `app` — we were not going to need anyway.

### Persistence

**Settings in `data.json`, checks in per-note files.**
`saveData` rewrites the whole file, which is the wrong shape for a vault-sized body of checks that changes on every edit.
Settings go through `loadData` / `saveData` as the docs require; checks go to one file per note under the plugin folder through the vault adapter, so a write touches one note and loading is lazy.
Obsidian Sync is not in use here, so the shape is chosen for scale and blast radius rather than for conflicts — it just happens to be the right shape if Sync is ever switched on.

**Keyed by path, kept honest by events.**
`vault.on('rename', (file: TAbstractFile, oldPath: string) => …)` and `vault.on('delete', …)`, both wrapped in `registerEvent` so they detach on unload.
A path key plus a rename listener beats writing ids into the user's frontmatter.

**Deleting a note keeps its checks.**
A delete is reversible through the trash; deleting the assessments along with it is not.
They are retained, marked orphaned, listed in the leaf's unanchored section, and pruned by command.

**The refusal to overwrite survives; the `.bak` rotation does not.**
`loadData` and the adapter both throw, and carrying on with defaults after a failed read is the same silent-and-total failure the desktop app hit — so a file we could not read is never written over, and the leaf says so.
Rotation earns less here, because one file is one note's checks rather than the whole library.

**Nested card questions are unaffected.**
Their offsets address the stored body string, which the port does not change.
The card is built with `createEl` / `MarkdownRenderer` instead of `innerHTML`, but the anchor never addressed the DOM.

### The leaf

**Clicking a check scrolls to and selects its span.**
Selecting used to re-arm the floating pill, which is why this was a question at all; with the pill gone, selection is free.

**Asking about a card still works.**
The leaf is our own DOM, `getSelection` behaves normally in it, and the existing offset-anchor path ports unchanged.

### Settings and shipping

**Commands.**
Check the selection, open the leaf, re-anchor orphans, prune checks for deleted notes.
All unbound by default, which the guidelines ask for in as many words.

**Settings.**
The key field — pasted, verified against the chosen model, written to the fixed path, never shown back — plus the model, the effort, and the demo-mode toggle.
Effort is offered above a smaller model because it is the cheaper trade: it keeps the model that is good at this and spends less thinking on it.
The model default does not move on its own, and the setting says what is being traded away rather than presenting four names at one price.

**Tests.**
`@codemirror/state` and `@codemirror/view` are ordinary npm packages, so the assertions that carry the risk — mapping through changes, boundary inclusivity, quote re-anchoring — run headless against CM6 with no Obsidian in the room.
The Obsidian-facing shell goes behind a thin adapter and gets manual passes in a scratch vault.
That keeps the anchoring suite, which is the part we cannot afford to lose.
The checker is the first instance of this split and it holds: `protocol.ts` is pure and has 13 assertions against it, `index.ts` is the only file that imports `obsidian`.
Four modules followed it — the session, the store, the card body arithmetic and settings — and the split is now enforced rather than observed: the test build marks nothing external, so a pure module that reaches for `obsidian` fails to build instead of quietly becoming untestable.
That is how the settings split was caught.

## Revisit before submitting

Nothing here blocks building.

**Nothing has been run inside Obsidian.**
This is the one that matters.
Every assertion here is headless, and the bundle has only been loaded against stubbed `obsidian` and `@codemirror` modules — which proves the wiring executes and proves nothing about the app.
The first real session in a scratch vault is the actual verification gate, and the assumptions most likely to be wrong are the ones read out of `obsidian.d.ts` rather than exercised: `frontmatterPosition`, `getRightLeaf` / `revealLeaf`, the Reading-to-Source `setViewState` switch, and whether `editorInfoField` knows its file at the moment a view plugin is constructed.

**`isDesktopOnly`.**
Settled: true, because nobody has looked at the leaf at phone width.
See *Build* — the read-only mobile path is written, so this is reversible the moment someone does look.

**Obsidian Sync.**
Not in use, so the write cadence is unconstrained today.
If it is ever switched on, per-note check files rewritten every few seconds want a real two-device test.
