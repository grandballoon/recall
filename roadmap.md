# Recall — Roadmap

## Bugs


## Features

- The two surfaces have drifted, and the canonical one is the one that's behind.
  `src/index.html` carries four changes the live artifact doesn't: backtick code
  spans in response bodies, the literal-unicode-escape fix, the sidebar no longer
  re-sorting on entry click, and the quoted span dropped from comment cards.
  The artifact also still shows the leftover test blue dot.
  Porting those back is a republish to the same artifact URL.

## Later / ideas



## Done

- 2026-09-11 — An unreadable `library.json` no longer destroys the library.
  The old boot path swallowed every hydrate failure into a bare `false`, seeded a
  fresh entry, and left persistence switched on — so roughly a second later the
  seed was saved over the library it had just failed to read.
  A truncated file, a stray byte, or a future `v: 2` schema bump would all have
  taken the whole library with them, silently and with no backup.
  Now `hydrateFromRaw` reports why it failed; only "nothing saved yet" seeds.
  Anything else enters safe mode: persistence off for the session, an
  undismissable banner, and a button that reveals the file and its backup in
  Finder via the new `library_reveal` command.
  `library_save` also rotates the copy it replaces to `library.json.bak` first,
  by rename rather than copy, so it costs nothing at any size.
  Verified the ten hydrate branches in JavaScriptCore — the engine the webview
  actually runs — and the store's rotation in five new Rust tests (12 total).
  Measured while I was in there: at 2000 worked entries (25MB) a save costs about
  140ms end to end, and the disk write dominates, so size is not the constraint —
  the sidebar's full DOM rebuild on every entry switch is what degrades first,
  somewhere in the high hundreds of entries.
- 2026-09-11 — Recall is a real Mac app you can keep in the Dock.
  `scripts/install-macos.sh` builds the release bundle, installs it to
  `/Applications/Recall.app`, re-registers it with LaunchServices, and pins it to
  the Dock; re-running it replaces the installed copy in place, so the Dock tile
  keeps working and just picks up the newer build.
  The app is now signed with the Developer ID Application certificate already in
  the keychain rather than left linker-signed, which gives it a stable identity —
  the Keychain grants access to the stored Anthropic key by code signature, so the
  key now survives reinstalls instead of macOS re-asking after every build.
  The icon was rebuilt in the macOS 26 format: `src-tauri/icons/Recall.icon` is an
  Icon Composer document (a gradient ground, a cream page, one amber-highlighted
  span — Recall's actual gesture) that the bundler compiles with `actool` into an
  `Assets.car`, so the app gets the real Liquid Glass treatment instead of being
  shrunk into the grey placeholder tile Tahoe gives full-bleed legacy icons.
  The legacy `.icns` was regenerated from the same artwork, on Apple's classic
  824-in-1024 grid, as the pre-26 fallback.
  Tauri CLI was updated 2.9.4 → 2.11.4, which is where `.icon` support landed; the
  Rust dependencies were already current (tauri 2.11.5).
  Typography is now bundled (`src/fonts/`, `src/fonts.css`, latin + latin-ext,
  ~260KB) instead of pulled from Google Fonts at launch — offline the app would
  otherwise fall back to system faces and the whole page would shift.
  Also fixed the unrelated `cargo fmt` drift in `files.rs`; `cargo test` (7),
  `cargo clippy`, and `cargo fmt --check` are all green.
- 2026-09-02 — Individual entries can be renamed. Each Library row is now wrapped
  in a `.lib-row`; a hover-revealed "Rename" button (or a double-click on the row)
  swaps the title for an inline text field. Enter or blur commits `e.title` and
  calls `persist()`; Escape discards. Rename does not bump `updatedAt`, so the
  shelf order holds still while you work down the list. Same change in both
  `artifact/index.html` and `src/index.html`. Verified in real Chromium — Enter /
  blur / Escape paths, no stray inputs left behind, and `display:none` (not the
  `hidden` attribute) on the concealed button so it actually beats
  `.lib-item { display:flex }`.
- 2026-09-02 — Wired the right-hand wing (was reserved) to a files folder on disk:
  a real, user-chosen folder the app lists, imports into, opens from, and deletes
  within. Defaults to `~/Documents/Recall`; the choice is remembered in
  `config.json`. New `files.rs` — thin `std::fs` wrapper on one dir, file names
  constrained to a single path component. Added `tauri-plugin-dialog` (native
  pickers) and `tauri-plugin-opener` (hand a file/folder to the OS), both driven
  from Rust so no `capabilities/` wiring is needed. Frontend: file list with
  size/date, add/open/reveal/delete, empty state, disabled outside the app. It's
  a shared shelf for now — files aren't tied to individual entries, and there's
  no folder watcher (a re-open re-reads). `cargo test` still green.
- 2026-09-02 — Revived the Tauri desktop app as a second surface, now serving the
  current (artifact-derived) UI. New `src/index.html` built from
  `artifact/index.html`: real `<html>` document, loads `claude.js`, API-key
  connect/disconnect block folded back into the settings popup. AI checks call the
  existing `claude_assess` command (`claude.rs` unchanged — already a current
  Messages API integration: `claude-opus-5`, adaptive thinking, JSON-schema
  output, server-side refusal fallback, whole-page prompt cached ahead of the
  span). Library persistence moved from `claudeArtifact.publish` to two new Rust
  commands, `library_load` / `library_save` (`src-tauri/src/library.rs`), which
  write `library.json` in the app data dir atomically and treat the payload as
  opaque bytes. `cargo test` green (7 tests). Full `cargo tauri dev` / bundle not
  run here — the Tauri CLI isn't installed in this environment.
- 2026-09-02 — Fixed the highlight-boundary bug (was in `## Bugs` above): typing off the end of a checked/unresolved highlight no longer gets absorbed into the `<mark>`. Chromium's contenteditable defaults to extending the trailing inline element when the caret sits right at its end, which is what caused it. Added `fixHighlightBoundary()`, wired into the `#editor` `input` listener: each mark tracks its real length in `data-len`; on an insertion, if the caret lands exactly at the mark's current end, whatever got typed there is popped back out as a plain sibling node, while an edit strictly *inside* the mark still grows or shrinks it as before. Verified against real Chromium (not just a DOM shim) with a headless Playwright script — confirmed the raw bug first (typing after a mark gets absorbed), then confirmed the fix stops it, including a shrink-then-append case. Republished to the live artifact URL; `artifact/index.html` here matches what's live.
- 2026-09-02 — Initial Recall artifact published ("Recall — a desk for testing what you know"), using `window.claude`'s `sample` capability for AI checking on the normal subscription.
- 2026-09-02 — Decided: artifact is canonical going forward; Tauri app retired.
  _(Partly reversed later that day — the Tauri app is back as a second surface, not
  a replacement. The artifact stays canonical.)_
- 2026-09-02 — Network egress enabled (scoped to the artifact's specific domain) so Claude sessions can read the live artifact's source directly.
- 2026-09-02 — Pulled the live artifact's actual source and saved it to `artifact/index.html`; corrected `spec.md`'s persistence section after reading the full source (persistence is already implemented, via the artifact's own save-a-version capability — not missing, as first assumed).
- 2026-09-02 — Proved out the edit → republish loop: added a small blue dot to the live UI as a test, republished to the same artifact URL, confirmed it doesn't need `device_bash` or the local git repo to work.
- ~~Archive `src/` and `src-tauri/` into `attic/`.~~ Cancelled — the desktop app
  is live again, so both directories stay in place. `attic/` is currently empty.
- The test blue dot (`.test-dot`, bottom-right) was dropped from `src/index.html`
  during the port. `artifact/index.html` still carries it, matching what's live —
  removing it there is a separate republish.
- Sync `artifact/index.html` on disk with what's actually live — the matching file was written to `~/Code/recall/artifact/index.html`. Committed 2026-09-11.
- ~~Sort out the leftover uncommitted `recall.html` and `.gitignore`.~~ Resolved
  2026-09-11: `recall.html` was the original single-file prototype from the first
  commit and is gone; `artifact/index.html` is the right path for the live
  artifact's source, and the whole working tree is committed.
- `device_bash` (Cowork's local sandbox) is still down — known bug, survives app restarts. Git operations that need it can be run in your own Terminal instead in the meantime.

## Superseded (from the old Tauri-era roadmap)

- ~~Add a way to connect Claude~~ — done on both surfaces: the artifact via
  `window.claude`, the desktop app via the API-key settings block + `claude_assess`.
