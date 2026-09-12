# Recall — Specification

_Status: draft. Grounded in the live artifact's source (pulled 2026-09-02) and the
revived Tauri desktop app that reuses it (2026-09-02)._

## Surfaces

Recall now ships on two surfaces that share one UI:

- **Claude artifact** — canonical and live. AI checks run through `window.claude`'s
  `sample` capability on the normal subscription; persistence uses the artifact's
  own save-a-version mechanism. Source: `artifact/index.html`.
- **Tauri desktop app** — a native window that serves the same UI from `src/`.
  AI checks run against the user's own Anthropic API key (held in the OS keychain);
  the library is persisted to a JSON file in the app data directory; a
  user-chosen folder on disk holds source-material files. Backend: `src-tauri/`.

The sections below describe the shared behaviour; where the two surfaces differ,
both are called out.

## What it is

Recall ("a desk for testing what you know") is an active-recall study tool, in the Feynman-technique sense: you write an explanation of something from memory in a plain writing surface, then get it checked span by span rather than graded as a whole.

The goal is active recall of small, detailed chunks, and progressively refining one's own understanding. 

## How it works

You select (highlight) a span of what you wrote. That opens a comment thread against just that span — the surrounding text is sent along as context, but only the highlighted span is what gets assessed. The checker returns a verdict — `wrong`, `imprecise`, `missing`, or `solid` — plus a short note, rendered as a margin comment next to the highlighted text (comments can sit on the left or right side; that preference is remembered in `localStorage`).

## The AI checker

The prompt framing is the same on both surfaces: "a precise, generous tutor
helping someone test their understanding through active recall," assessing only
the highlighted span and returning a typed verdict plus a short note.

- **Artifact:** the page calls Claude via `window.claude`'s `sample` capability —
  billed against the normal Claude subscription, no separate API key.
- **Desktop:** the webview calls a Tauri command (`claude_assess`), which reads
  the stored API key and hits the Anthropic Messages API from Rust
  (`src-tauri/src/claude.rs`): `claude-opus-5`, adaptive thinking, a JSON-schema
  output constraint, and the server-side refusal fallback. The whole page is sent
  and cached ahead of the span, so checking several spans of one unedited page
  replays the prefix from cache. The API key never crosses back into the webview.

If the checker can't be reached (capability/command unavailable, no key connected,
or the call fails), both surfaces fall back to placeholder "demo mode" feedback
rather than failing silently. A failed check leaves the verdict blank on purpose —
the span was never assessed, so labelling the writing would misreport what happened.

## Data model / persistence

The whole library (all entries — prose, comment threads, verdicts, the library
index) is serialized to a single JSON string, debounced ~1.2s after each edit,
and read back at boot to hydrate `state.library`. If persistence is unavailable
it falls back to in-memory only for that session (no crash, just no save).
`localStorage` is used separately, only for one UI preference (which side the
comment panel opens from) — not document content.

- **Artifact:** the JSON is written through `claude.use('artifact')` →
  `claudeArtifact.publish({'data/library.json': ...})` and read back from the
  `#recall-data` script tag the server embeds into the page.
- **Desktop:** the JSON is written through the `library_save` Tauri command to
  `library.json` in the app data directory (atomic temp-write + rename) and read
  back through `library_load` at boot. The Rust side treats the string as opaque
  bytes — the library's shape lives entirely in the webview, so the store never
  changes when the document model does.

### Not losing the library (desktop)

Every save rewrites the whole library, so the newest write would otherwise be the only copy in existence.
Two things guard against that.

First, each save rotates the copy it replaces to `library.json.bak` before the new bytes land.
The rotation is a rename rather than a copy, so it costs nothing at any library size and cannot fail halfway.

Second, a library that cannot be read is never written over.
`hydrateFromRaw` reports *why* it failed rather than returning a bare false, and only "nothing saved yet" leads to seeding a first entry.
Unparseable content, content that isn't shaped like a library, and an unrecognised format version all put the app into **safe mode**: persistence is switched off for the session, a banner that cannot be dismissed says so, and a button reveals the file and its backup in Finder.
The session still works — you can write in it — but only in memory.

This matters because the failure it prevents is silent and total.
Seeding a fresh library while persistence stayed on would save the seed over the library it had just failed to read, roughly a second later.
The same applied to a bumped format version, which would have wiped every existing library on first launch of the new version.

## Files folder (desktop only)

The right-hand wing is a view onto a real folder on disk — source material to
check yourself against: a paper, your own notes, a reference summary. It defaults
to `~/Documents/Recall`, is changeable via a native folder picker, and the choice
is remembered in `config.json` in the app data directory.

`files.rs` is a thin wrapper over `std::fs` on that one directory: `files_list`
(regular files, newest first, dotfiles skipped), `files_import` (native
multi-file picker → copy in, collision-suffixed), `files_open` / `files_reveal`
(hand off to the OS via the opener plugin), `files_delete`. File names are
constrained to a single path component, so nothing can be read or written outside
the folder. The folder is a shared shelf — files are not yet associated with
individual entries. Anything dropped into the folder from the file browser shows
up on the next open; there is no watcher.

## Installing the Mac app

`scripts/install-macos.sh` builds the release bundle, installs it to `/Applications/Recall.app`, and puts it in the Dock.
Re-running it replaces the installed copy in place, so the Dock tile keeps working and simply picks up the newer build.
Pass `--no-dock` to skip the Dock step.
The script refuses to replace anything at that path whose bundle identifier is not Recall's, so a name collision cannot cost another app.

The app is signed with a Developer ID Application certificate when one is present in the keychain, and ad-hoc otherwise.
This matters beyond Gatekeeper: the Keychain grants access to the stored Anthropic key by code signature, so a stable Developer ID signature means the key survives reinstalls, where an ad-hoc signature changes on every build and makes macOS ask again.
The build is not notarized, which is fine for a locally built app — notarization only matters for a bundle that travels to another machine and arrives quarantined.

The icon is an Icon Composer document, `src-tauri/icons/Recall.icon`, which the Tauri bundler compiles with `actool` into an `Assets.car` referenced by `CFBundleIconName`.
This is the macOS 26 icon format: a background fill plus layered art that the system masks, shadows, and gives the Liquid Glass treatment, rather than a flat pre-rendered square.
A legacy `.icns` is still generated from the same artwork and stays in the bundle as the pre-26 fallback.
Regenerating that fallback means rendering the `.icon` to a PNG with Icon Composer's `ictool`, insetting it to Apple's classic 824-in-1024 grid, and running `cargo tauri icon` on the result.

Typography is bundled rather than fetched.
`src/fonts/` holds the Spectral and Inter woff2 files (latin and latin-ext only) and `src/fonts.css` declares them; both families are under the SIL Open Font License 1.1.
A desktop app must not depend on a font CDN at launch, since offline it would quietly fall back to system faces and the whole page would shift.
The artifact keeps using the Google Fonts link, because there the CDN is part of the runtime it already lives in.

## Constraints / non-goals

- The **artifact** must keep working entirely inside the Claude artifact runtime —
  `window.claude` for AI access, no external API key.
- The **desktop app** must keep the API key out of the webview: it lives in the OS
  keychain and only ever crosses into Rust, never back to page content. The
  frontend learns only whether a key is stored and which model checks run on.
- Both surfaces share one UI. `src/index.html` is derived from `artifact/index.html`
  and should track it — divergence is limited to the AI-check call, the
  persistence call, and how fonts are loaded.

## History

This repo originally held a Tauri native-desktop-app version of Recall (Rust
backend + API-key-based Claude access via the OS keychain). On 2026-09-02 that
variant was set aside in favour of the Claude artifact, which had become
canonical.

Later the same day the Tauri harness was revived as a second delivery surface
rather than a replacement. The old hand-written `src/index.html` was rebuilt from
`artifact/index.html` (real `<html>` document, `claude.js` bridge, the API-key
settings block folded back into the settings popup); the `sample` call was
swapped for the `claude_assess` command and the artifact-publish persistence for
`library_save`/`library_load`. The Rust `claude.rs` needed no changes — it was
already a current Anthropic Messages API integration. `src-tauri/` and `src/` are
no longer slated for `attic/`; both are live again.

The previously-reserved right-hand wing was then wired to a files folder on disk
(`files.rs`, `tauri-plugin-dialog` + `tauri-plugin-opener`), so source material
lives in a real, user-chosen folder the app reads from and writes to.
