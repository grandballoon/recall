# Recall — Specification

_Status: draft, now grounded in the live artifact's actual source (pulled 2026-09-02)._

## What it is

Recall ("a desk for testing what you know") is an active-recall study tool, in the Feynman-technique sense: you write an explanation of something from memory in a plain writing surface, then get it checked span by span rather than graded as a whole.

## How it works

You select (highlight) a span of what you wrote. That opens a comment thread against just that span — the surrounding text is sent along as context, but only the highlighted span is what gets assessed. The checker returns a verdict — `wrong`, `imprecise`, `missing`, or `solid` — plus a short note, rendered as a margin comment next to the highlighted text (comments can sit on the left or right side; that preference is remembered in `localStorage`).

## The AI checker

Running as a Claude artifact, the page calls Claude via `window.claude`'s `sample` capability — billed against the normal Claude subscription, no separate API key. The prompt framing: "a precise, generous tutor helping someone test their understanding through active recall," assessing only the highlighted span.

If the checker can't be reached (`sample` unavailable, or the call fails), it falls back to placeholder "demo mode" feedback rather than failing silently, so the UI is never left showing nothing.

## Data model / persistence

Not yet implemented. Session content (the written text, the comment threads and verdicts) currently only lives in page memory — nothing survives a reload. `localStorage` is used only for one UI preference (which side comments render on), not the actual document. See roadmap: adding real persistence is the next real feature, and needs to use an artifact capability (e.g. its own small database) rather than filesystem access, which doesn't apply to an artifact the way it did to the old Tauri app design.

## Constraints / non-goals

Must keep working entirely inside the Claude artifact runtime — `window.claude` for AI access, no external API key. This was a deliberate move away from the earlier Tauri-native-app design (see History), which required the user to supply and store their own Anthropic API key.

## History

This repo originally held a Tauri native-desktop-app version of Recall (Rust backend + API-key-based Claude access via the OS keychain). That variant is retired as of 2026-09-02 in favor of the Claude artifact; its source is archived under `attic/` (or wherever you choose to move it) rather than deleted, so the work isn't lost.
