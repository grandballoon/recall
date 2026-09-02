# Recall — Roadmap

## Now

- Get the new `artifact/index.html` (the live artifact's real source, pulled 2026-09-02) added to git, and the old Tauri code (`src/`, `src-tauri/`) moved out of the way. Commands are ready — see below — but need to be run in a real shell. Cowork's local sandbox (`device_bash`) is currently down with a known, unresolved bug on macOS (survives app restarts); run these yourself in Terminal for now, or wait for Anthropic to fix the sandbox.

  ```
  cd ~/Code/recall
  git status                     # sanity-check what's already tracked before committing
  git add spec.md roadmap.md artifact/index.html
  git commit -m "Add live Recall artifact source; write spec and roadmap"

  # optional, once you're ready to archive the Tauri variant:
  mkdir -p attic
  git mv src attic/tauri-src
  git mv src-tauri attic/tauri-app
  git commit -m "Archive Tauri variant now that the Claude artifact is canonical"
  ```

## Next

- Real persistence: some way to save and reload a session's written text + comment threads, using an artifact capability (its own small database, most likely) rather than the old filesystem-based design.
- Decide on the standing update workflow: edit `artifact/index.html` locally → commit → have a Claude session read the live artifact, apply the same diff, and republish to the same URL.

## Later / ideas

- (nothing groomed yet)

## Done

- 2026-09-02 — Initial Recall artifact published ("Recall — a desk for testing what you know"), using `window.claude`'s `sample` capability for AI checking on the normal subscription.
- 2026-09-02 — Decided: artifact is canonical going forward; Tauri app retired.
- 2026-09-02 — Network egress enabled (scoped to the artifact's specific domain) so Claude sessions can read the live artifact's source directly.
- 2026-09-02 — Pulled the live artifact's actual source and saved it to `artifact/index.html`.

## Superseded (from the old Tauri-era roadmap)

- ~~Add a way to connect Claude~~ — moot; the artifact already has Claude access built in via `window.claude`.
