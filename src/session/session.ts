/* What a note's checks are doing right now — the join between the three
 * stages that landed before it.
 *
 * The store knows what is on disk, the decoration field knows where a span is
 * in a live document, and neither knows about the other. This is the only
 * thing that does: it loads a note's checks, puts each one back on its span,
 * broadcasts the result to every editor showing that note, keeps the stored
 * offsets current as the text moves, and writes the result back.
 *
 * Nothing here imports `obsidian`. The broadcast goes through an interface the
 * `ViewRegistry` happens to satisfy, so the whole of this file runs headless
 * against a real CM6 document with a map for a disk.
 */
import { resolveAnchor } from '../anchor/anchoring';
import type { Check as LiveCheck } from '../anchor/field';
import { hasSpan, type StoredCheck } from '../store/format';
import type { CheckStore } from '../store/store';
import type { Verdict } from '../checker/protocol';

/** The slice of `ViewRegistry` this needs. */
export interface Broadcaster {
  setChecks(path: string, checks: readonly LiveCheck[]): void;
  lit(path: string, id: string | null): void;
}

/** One note's checks, in memory, at their current positions. */
export interface NoteChecks {
  path: string;
  /** Every check for the note, keyed by id. Insertion order is the order they
   *  were made, which is the order the leaf lists them in. */
  byId: Map<string, StoredCheck>;
}

/** What a re-anchor pass managed to do, for the sentence the leaf reports. */
export interface ReanchorResult {
  placed: number;
  stuck: number;
}

/** A check is on the note itself rather than hanging off another check's
 *  note. Only these address the document, so only these get decorations. */
function isTopLevel(check: StoredCheck): boolean {
  return check.parentId === null;
}

/** Written rather than assigned, so `unanchored: false` never reaches disk —
 *  the absent key and the false one mean the same thing, and only one of them
 *  costs bytes in every file. */
function withAnchorState(check: StoredCheck, unanchored: boolean): StoredCheck {
  const { unanchored: _drop, ...rest } = check;
  return unanchored ? { ...rest, unanchored: true } : rest;
}

/** Puts a note's stored checks back on their spans.
 *
 *  Exported for the tests: this is the load path, and it is where a note
 *  edited while the plugin was not watching either recovers or does not. */
export function anchorAll(
  path: string,
  stored: readonly StoredCheck[],
  doc: string,
): NoteChecks {
  const byId = new Map<string, StoredCheck>();
  for (const check of stored) {
    if (!isTopLevel(check) || !hasSpan(check)) {
      // Nested checks address their parent's note text, not the document, and
      // a question put to the whole note addresses nothing in particular.
      byId.set(check.id, check);
      continue;
    }
    const found = resolveAnchor(doc, check);
    byId.set(
      check.id,
      found.kind === 'exact' || found.kind === 'quote'
        ? withAnchorState({ ...check, from: found.from, to: found.to }, false)
        : withAnchorState(check, true),
    );
  }
  return { path, byId };
}

/** Whether putting the checks back actually changed any of them — a moved
 *  offset, or a span that has gone missing since the last write. */
function anchoringChanged(stored: readonly StoredCheck[], note: NoteChecks): boolean {
  return stored.some((before) => {
    const after = note.byId.get(before.id);
    if (!after) return true;
    return (
      after.from !== before.from ||
      after.to !== before.to ||
      (after.unanchored ?? false) !== (before.unanchored ?? false)
    );
  });
}

/** The checks that should be drawn in the editor: on the note, anchored, and
 *  not yet dealt with. */
export function liveChecks(note: NoteChecks): LiveCheck[] {
  const live: LiveCheck[] = [];
  for (const check of note.byId.values()) {
    if (!isTopLevel(check) || !hasSpan(check) || check.unanchored || check.resolved) continue;
    live.push({ id: check.id, from: check.from, to: check.to, verdict: check.verdict });
  }
  return live;
}

/** Checks with a note but nowhere to put it: the leaf's section at the top. */
export function unanchoredChecks(note: NoteChecks): StoredCheck[] {
  return [...note.byId.values()].filter(
    (c) => isTopLevel(c) && c.unanchored === true && !c.resolved,
  );
}

/** Top-level checks in the order they were made. */
export function noteChecks(note: NoteChecks): StoredCheck[] {
  return [...note.byId.values()].filter(isTopLevel);
}

/** Everything hanging off one card, in the order it was asked. */
export function childrenOf(note: NoteChecks, id: string): StoredCheck[] {
  return [...note.byId.values()].filter((c) => c.parentId === id);
}

/** What `add` is given. Without a span it is a question put to the whole
 *  note, or the next line of a thread. */
export interface NewCheck {
  span?: { from: number; to: number; quote: string } | null;
  parentId?: string | null;
  /** Present when the reader asked something rather than asking for a
   *  verdict. */
  question?: string;
}

let counter = 0;
function defaultId(): string {
  // Unique across sessions without an index to keep in step, and short enough
  // to read in a file someone opens by hand.
  counter += 1;
  return `c${Date.now().toString(36)}${counter.toString(36)}`;
}

export class CheckSession {
  private readonly notes = new Map<string, NoteChecks>();
  private readonly listeners = new Set<(path: string) => void>();

  constructor(
    private readonly store: CheckStore,
    private readonly views: Broadcaster,
    private readonly newId: () => string = defaultId,
  ) {}

  /** The leaf re-renders when the note it is showing changes. Returns its own
   *  unsubscribe, so the caller never has to hold the function it passed. */
  onChange(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(path: string): void {
    for (const listener of this.listeners) listener(path);
  }

  private broadcast(note: NoteChecks): void {
    this.views.setChecks(note.path, liveChecks(note));
  }

  /** What is loaded for a note, or nothing. Synchronous, because the leaf
   *  renders synchronously and `open` is what does the loading. */
  peek(path: string): NoteChecks | null {
    return this.notes.get(path) ?? null;
  }

  /** Draws a loaded note's checks again, for an editor that has just appeared
   *  — a split pane, or a tab that was deferred until it was opened. Says
   *  whether there was anything loaded to draw. */
  redraw(path: string): boolean {
    const note = this.notes.get(path);
    if (!note) return false;
    this.broadcast(note);
    return true;
  }

  /** Loads a note's checks and draws them, or redraws what is already loaded.
   *
   *  Re-opening a loaded note broadcasts again rather than returning quietly:
   *  a second editor on the same file starts with no decorations of its own,
   *  and this is what fills it. */
  async open(path: string, doc: string): Promise<NoteChecks> {
    const loaded = this.notes.get(path);
    if (loaded) {
      this.broadcast(loaded);
      return loaded;
    }

    const stored = await this.store.load(path);
    const note = anchorAll(path, stored, doc);
    this.notes.set(path, note);
    this.broadcast(note);
    this.notify(path);

    // Anchoring can move a check whose document shifted while we were not
    // watching, and that repair is worth keeping. Only when it actually
    // repaired something, though — opening a note should not cost a write.
    if (anchoringChanged(stored, note)) this.store.queue(path, [...note.byId.values()]);
    return note;
  }

  /** CM6 moved the decorations; the stored offsets follow.
   *
   *  Called on every document change, so it does no work and raises no event
   *  when nothing actually moved — the leaf does not show offsets, and a
   *  re-render per keystroke would be a re-render per keystroke. */
  moved(path: string, live: readonly LiveCheck[]): void {
    const note = this.notes.get(path);
    if (!note) return;

    let changed = false;
    for (const current of live) {
      const check = note.byId.get(current.id);
      if (!check || (check.from === current.from && check.to === current.to)) continue;
      note.byId.set(current.id, { ...check, from: current.from, to: current.to });
      changed = true;
    }
    if (changed) this.store.queue(path, [...note.byId.values()]);
  }

  /** An edit deleted these spans.
   *
   *  The records survive it. Undo re-inserts the text without bringing the
   *  decoration back, so the check is re-anchored from its quote — either by
   *  the next `open`, or by the leaf's re-anchor command. */
  dropped(path: string, ids: readonly string[]): void {
    const note = this.notes.get(path);
    if (!note) return;

    let changed = false;
    for (const id of ids) {
      const check = note.byId.get(id);
      if (!check || check.unanchored) continue;
      note.byId.set(id, withAnchorState(check, true));
      changed = true;
    }
    if (!changed) return;

    this.store.queue(path, [...note.byId.values()]);
    this.notify(path);
  }

  /** Retries every unanchored check against the document as it stands.
   *
   *  Only on being asked. A check goes back only where its quote appears
   *  exactly once, because putting one on the wrong sentence is worse than
   *  leaving it unplaced — which is the rule `findQuote` already enforces. */
  reanchor(path: string, doc: string): ReanchorResult {
    const note = this.notes.get(path);
    if (!note) return { placed: 0, stuck: 0 };

    let placed = 0;
    let stuck = 0;
    for (const check of unanchoredChecks(note)) {
      const found = resolveAnchor(doc, check);
      if (found.kind === 'exact' || found.kind === 'quote') {
        note.byId.set(check.id, withAnchorState({ ...check, from: found.from, to: found.to }, false));
        placed += 1;
      } else {
        stuck += 1;
      }
    }

    if (placed > 0) {
      this.store.queue(path, [...note.byId.values()]);
      this.broadcast(note);
      this.notify(path);
    }
    return { placed, stuck };
  }

  /** Records a new check and draws it. The assessment arrives later through
   *  `assessed` — or, for a question, the answer through `answered` — so the
   *  card exists, pending, from the moment it is asked for rather than when
   *  the reply lands. */
  add(path: string, asked: NewCheck): StoredCheck {
    const note = this.notes.get(path) ?? { path, byId: new Map<string, StoredCheck>() };
    this.notes.set(path, note);

    const check: StoredCheck = {
      id: this.newId(),
      from: asked.span?.from ?? 0,
      to: asked.span?.to ?? 0,
      quote: asked.span?.quote ?? '',
      verdict: null,
      body: '',
      parentId: asked.parentId ?? null,
      ...(asked.question === undefined ? {} : { question: asked.question }),
    };
    note.byId.set(check.id, check);

    this.store.queue(path, [...note.byId.values()]);
    this.broadcast(note);
    this.notify(path);
    return check;
  }

  /** The answer came back — or did not, in which case the verdict stays null
   *  on purpose. The span was never assessed, so labelling the writing would
   *  be a lie about what happened. */
  assessed(path: string, id: string, verdict: Verdict | null, body: string): void {
    const note = this.notes.get(path);
    const check = note?.byId.get(id);
    if (!note || !check) return;

    note.byId.set(id, { ...check, verdict, body });
    this.store.queue(path, [...note.byId.values()]);
    this.broadcast(note);
    this.notify(path);
  }

  /** A question got its reply. `failed` marks a body that is a placeholder or
   *  an error rather than an answer, which is what keeps it out of the
   *  conversation the next question is asked with. */
  answered(path: string, id: string, body: string, failed: boolean): void {
    const note = this.notes.get(path);
    const check = note?.byId.get(id);
    if (!note || !check) return;

    const { failed: _was, ...rest } = check;
    note.byId.set(id, failed ? { ...rest, body, failed: true } : { ...rest, body });
    this.store.queue(path, [...note.byId.values()]);
    this.notify(path);
  }

  /** Dealt with: the note stays on record, the highlight comes off. */
  resolve(path: string, id: string): void {
    const note = this.notes.get(path);
    const check = note?.byId.get(id);
    if (!note || !check) return;

    note.byId.set(id, { ...check, resolved: true });
    this.store.queue(path, [...note.byId.values()]);
    this.broadcast(note);
    this.notify(path);
  }

  /** Dismissed: the check and everything asked about it go.
   *
   *  A thread is deleted with its root, because a question about a note whose
   *  note no longer exists has nothing left to mean. */
  remove(path: string, id: string): void {
    const note = this.notes.get(path);
    if (!note?.byId.has(id)) return;

    const doomed = new Set<string>([id]);
    // Children may be recorded before or after their parent, so this repeats
    // until nothing new is caught rather than assuming one pass is enough.
    for (let grew = true; grew; ) {
      grew = false;
      for (const check of note.byId.values()) {
        if (check.parentId !== null && doomed.has(check.parentId) && !doomed.has(check.id)) {
          doomed.add(check.id);
          grew = true;
        }
      }
    }
    for (const gone of doomed) note.byId.delete(gone);

    this.store.queue(path, [...note.byId.values()]);
    this.broadcast(note);
    this.notify(path);
  }

  /** The highlight whose card is open fills with its own underline colour. */
  lit(path: string, id: string | null): void {
    this.views.lit(path, id);
  }

  /** A note moved. The store rewrites its file; this keeps the in-memory copy
   *  from answering to a path that no longer exists. */
  renamed(oldPath: string, newPath: string): void {
    const note = this.notes.get(oldPath);
    if (!note) return;
    this.notes.delete(oldPath);
    this.notes.set(newPath, { path: newPath, byId: note.byId });
  }

  /** Drops a note's in-memory copy. The file is untouched — this is for a
   *  note whose checks the store has taken over, not a deletion. */
  forget(path: string): void {
    this.notes.delete(path);
  }
}
