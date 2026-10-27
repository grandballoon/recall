# Recall

Write an explanation from memory in an Obsidian note, select a span, and get that span checked by Claude: `wrong`, `imprecise`, `missing` or `solid`, with a short note, kept beside the note in a side leaf.

What it does and why is in [spec.md](spec.md); what it stores is in [data.md](data.md); what is next is in [roadmap.md](roadmap.md).

## Layout

- `src/` — the Obsidian plugin. `main.ts` wires it into Obsidian; everything under it that does not import `obsidian` is pure and tested headless.
- `manifest.json`, `styles.css` — shipped beside the built `main.js`.
- `artifact/` — the Claude artifact, frozen until it is rebuilt, with its end-to-end tests in `artifact/tests/`.

## Build

Node 20.17 or newer.

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

`npm run dev` watches and `npm run check` typechecks.
To try it, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/recall/` and enable Recall under Community plugins.
Without a key every check runs in demo mode, so a scratch vault costs nothing.

The artifact's tests need any Chromium-based browser (Chrome, Brave, Chromium or Playwright's):

```bash
artifact/tests/run.sh
```

## History

The design notes that led the port, stage by stage, are in this file's history before 2026-10-26 (`git show 9a46976:README.md`).
The Tauri desktop app was removed in `706445f`.
