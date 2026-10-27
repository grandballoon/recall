# Recall — Specification

_Status: draft, being rewritten for the Obsidian plugin (2026-10-26).
The Tauri desktop app is gone; the Claude artifact is frozen until it is rebuilt._

## What it is

Recall ("a desk for testing what you know") is an active-recall study tool, in the Feynman-technique sense.
You write an explanation of something from memory, then get it checked span by span rather than graded as a whole.
The goal is active recall of small, detailed chunks, and progressively refining one's own understanding.

You select a span of what you wrote and ask for a check.
The surrounding note goes along as context, but only the span is assessed.
The checker returns a verdict — `wrong`, `imprecise`, `missing`, or `solid` — plus a short note, shown as a card.
Any part of a card can itself be selected and questioned, so checks nest into threads.

## Surfaces

**The Obsidian plugin** is the product.
It lives at the repo root: `src/`, `manifest.json`, `styles.css`.
The vault is the library: a note is an entry, and the checks on it are kept beside it by the plugin.

**The Claude artifact** (`artifact/index.html`) is frozen.
It is still published and still works inside the Claude artifact runtime, through `window.claude` with no API key, and its end-to-end tests live in `artifact/tests/`.
It will be rebuilt from scratch rather than kept in step with the plugin, so nothing in the plugin should be shaped around it.
Four fixes that only the deleted desktop page carried are in history at `3d2ce82:src/index.html`: backtick code spans in responses, literal unicode escapes, the sidebar no longer re-sorting on click, and the quoted span dropped from cards.

There are no webviews of our own.
The plugin runs in Obsidian's renderer and the artifact runs in Claude's.

## In a note

### Asking

A selection is checked from the editor context menu or the `check-selection` command.
A question in the reader's own words is asked through `ask-selection`, `ask-note`, or the box at the foot of the leaf.
Every command is unbound by default, so hotkeys are the reader's to assign.
A span inside frontmatter is never checked, because frontmatter is metadata rather than writing.

### What a verdict looks like

A verdict shows in three places, all read from one palette: the highlight in the note, the pill on its card, and the dot in the breadcrumb trail.
Orange is `wrong`, yellow is `imprecise`, blue is `missing`, green is `solid`.
`missing` deliberately sits off the traffic light: an incomplete answer is not a wrong one.

A highlight with no verdict is neutral grey.
That covers a check in flight, a check that failed, a check in demo mode, and every question.
Colouring the prose before an assessment exists would report something about the writing that nothing has established.

The colours are `--v-<verdict>-{wash,line,ink,on}` custom properties in `styles.css`, redefined under `.theme-dark` and keyed to Obsidian's own variables so they survive community themes.

### Anchoring

A highlight is a CM6 `Decoration.mark` in a `StateField`, registered with `registerEditorExtension`.
CM6 maps decorations through every edit, so a highlight follows its text as the reader types, and text typed at either boundary falls outside it.
Stored `{from, to}` offsets address the raw markdown, so they mean the same thing in Live Preview and Source mode.

Losing a decoration never deletes a check.
When an edit deletes a span, or a stored offset no longer fits, the check is re-anchored by its quote.
A quote is used only where it appears exactly once; an ambiguous or absent one is listed in the leaf's unanchored section and moves nothing until asked.

Highlights exist only in editing views.
In Reading mode the leaf is the only way to reach a note's checks, and a card offers "reveal in editor" rather than switching the reader's view for them.

Every editor showing a note registers itself with a small registry, so a new check is broadcast to all of them.
The plugin never reaches for the undocumented `editor.cm`.

### The leaf

One right-side `ItemView` lists the active note's checks and follows the reader between notes, the way Outline and Backlinks do.
Clicking a check scrolls to its span and selects it.
Depth stays inside the leaf as a card stack with a breadcrumb trail.
Dismissing a check removes the thread hanging off it.
Resolving one keeps the record but takes its highlight off the prose.

The box at the foot asks about whatever the reader is on: the note when the list is showing, the next line of an open thread, or a picked span.
Enter breaks the line and Cmd+Enter (Ctrl+Enter) sends.

### Questions

A question is a check with words on it, not a second kind of record.
It is stored, threaded, retried and dismissed exactly like a check, and it never produces a verdict.
A thread is stored as a tree and sent to Claude as a line: the question's ancestors, root first, with earlier follow-ups under the same card ahead of it.
A card whose body is a placeholder or an error is never replayed, because that would put words in Claude's mouth.
A span picked for a question is re-resolved when the question is sent, and refused out loud if its text is gone or no longer unique.

## The checker

`src/checker/protocol.ts` is the wire contract as pure functions, and `src/checker/index.ts` is the only transport, over Obsidian's `requestUrl`.
It calls the Anthropic Messages API directly with the reader's own key.

A check sends the note's text, without frontmatter, as a cached prefix, and the span after it.
Checking several spans of one unedited note therefore replays the prefix from cache.
`![[transclusions]]` go as written rather than resolved, so an embedded note changing does not invalidate the cache.
The answer is constrained by a JSON schema to `{verdict, note}`, with a fallback when the request is refused.
A question uses its own system prompt and asks for plain prose, because a card's text has to keep its offsets for nested selection.

The default model is `claude-opus-5`.
Effort is offered as the cheaper trade before a smaller model.
Demo mode returns placeholder cards and spends nothing.
A failed check leaves the verdict blank, because the span was never assessed.

## The API key

A plugin is the renderer, so the key is in the renderer whatever we do, and Obsidian has no secret store.
What is still ours to protect is the vault, which syncs and gets backed up.
So the key lives in one file outside the vault, `~/.config/recall/key` (`%APPDATA%\recall\key` on Windows), written `0600`.
The path is fixed rather than configurable, because a plugin that writes outside the vault has to justify it at review.
A pasted key is verified against the chosen model before it is stored, and it is never shown back.

## Persistence

Settings go to the plugin's `data.json` through `loadData` / `saveData`.
Checks go to one file per note under the plugin folder, because `saveData` rewrites the whole file and checks change on every edit.
A file that cannot be read is never written over, and the leaf says why.
A deleted note keeps its checks, marked deleted, until a prune; restoring the note from the trash clears the mark.
Renames are followed through `vault.on('rename')`.
The shapes are in [data.md](data.md).

## Build and ship

esbuild bundles `src/main.ts` to one `main.js`, with `obsidian`, `electron` and `@codemirror/*` external.
`npm run build`, `npm run dev`, `npm run check` (tsc) and `npm test`; Node 20.17 or newer.
Install by copying `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/recall/`.

The tests are headless.
CM6 runs in Node, so the editor state under test is real; the disk is a `Map`.
The test build marks nothing external, so a pure module that imports `obsidian` fails to build.

The plugin is written to the community-plugin review guidelines from the start: no `innerHTML`, no `editor.cm`, no global `app`, one network host, every command unbound.
`isDesktopOnly` is true until someone has looked at the leaf at phone width; a read-only mobile path is already written.

## Constraints

- The plugin stands on public Obsidian and CodeMirror API only.
- Logic lives in pure modules tested headless; only `main.ts`, the leaf, the settings tab and the checker transport import `obsidian`.
- The note stays clean markdown: no `==marks==`, no frontmatter written by us.
- The API key never enters the vault.
- The artifact keeps working inside the Claude artifact runtime, with `window.claude` and no API key, until it is rebuilt.

## Open

- **Nothing has been run inside Obsidian.** The first session in a scratch vault is the real verification gate. The assumptions most likely to be wrong are the ones read out of `obsidian.d.ts` rather than exercised: `frontmatterPosition`, `getRightLeaf` / `revealLeaf`, the Reading-to-Source switch, and whether `editorInfoField` knows its file when a view plugin is constructed.
- **Prompts.** Where an entry's prompt comes from is undecided. A `recall-prompt` frontmatter key with the note title as fallback was proposed and not built.
- **Obsidian Sync.** Not in use. Per-note files rewritten every few seconds want a two-device test if it is switched on.
- **Mobile.** No key file to read there, so mobile could only ever be read-only.
- **The artifact rebuild.** Scope and timing are open.
