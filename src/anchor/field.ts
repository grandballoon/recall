/* Where a highlight lives now.
 *
 * On the other two surfaces a highlight is a set of `<mark>` elements in a
 * contenteditable, kept in place by hand. Here it is a `Decoration.mark` in a
 * `StateField`, and CM6 maps it through `tr.changes` on every edit — so a
 * highlight follows its text as the user types above it, and a span that is
 * deleted takes its decoration with it. The defects that cost the desktop app
 * three commits are handled by the framework.
 *
 * Two things this file is careful about:
 *
 *  - Marks are not inclusive, so text typed against either boundary falls
 *    outside the highlight. That is what `fixHighlightBoundary` and `data-len`
 *    did by hand, and CM6's default already agrees with it.
 *  - A decoration dropped by an edit is reported, never silently forgotten.
 *    The check record outlives its decoration: undo re-inserts the text but
 *    does not resurrect the mark, so the caller re-anchors from the quote.
 */
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import type { Verdict } from '../checker/protocol';

export interface Check {
  id: string;
  from: number;
  to: number;
  /** Null until an assessment exists — in flight, failed, or demo mode. The
   *  UI paints those neutral rather than reporting something nothing has
   *  established. */
  verdict: Verdict | null;
}

/** Replaces every highlight in the view — the load path, and the broadcast
 *  path when another view of the same file changes something. */
export const setChecks = StateEffect.define<readonly Check[]>();
export const addCheck = StateEffect.define<Check>();
export const removeCheck = StateEffect.define<string>();
/** The highlight whose card is open fills with its own underline colour. */
export const litCheck = StateEffect.define<string | null>();

export interface CheckDecorations {
  set: DecorationSet;
  /** Ids whose span was deleted by the transaction just applied. Reset every
   *  transaction: this is an event, not a running total. */
  dropped: readonly string[];
  lit: string | null;
}

function markFor(check: Check, lit: string | null): ReturnType<typeof Decoration.mark> {
  const classes = ['recall-check'];
  classes.push(check.verdict ? `recall-${check.verdict}` : 'recall-unassessed');
  if (check.id === lit) classes.push('is-lit');
  return Decoration.mark({
    class: classes.join(' '),
    attributes: { 'data-recall-check': check.id },
    id: check.id,
    verdict: check.verdict,
    // Text typed against either edge belongs to the prose, not the check.
    inclusive: false,
  });
}

function buildSet(checks: readonly Check[], lit: string | null): DecorationSet {
  const ranges = checks
    .filter((c) => c.from < c.to)
    .map((c) => markFor(c, lit).range(c.from, c.to));
  return Decoration.set(ranges, true);
}

function idsIn(set: DecorationSet): Set<string> {
  const ids = new Set<string>();
  const cursor = set.iter();
  while (cursor.value) {
    ids.add(cursor.value.spec.id as string);
    cursor.next();
  }
  return ids;
}

/** Reads the checks back out of the decorations, at their current positions. */
export function checksIn(set: DecorationSet): Check[] {
  const checks: Check[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    checks.push({
      id: cursor.value.spec.id as string,
      from: cursor.from,
      to: cursor.to,
      verdict: (cursor.value.spec.verdict ?? null) as Verdict | null,
    });
    cursor.next();
  }
  return checks;
}

export const checkField = StateField.define<CheckDecorations>({
  create() {
    return { set: Decoration.none, dropped: [], lit: null };
  },

  update(value, tr) {
    let set = value.set;
    let lit = value.lit;
    let dropped: readonly string[] = [];

    if (tr.docChanged) {
      const before = idsIn(set);
      set = set.map(tr.changes);
      // CM6 drops a mark whose range an edit collapsed. Diffing rather than
      // filtering means we report it whoever dropped it.
      const after = idsIn(set);
      const gone = [...before].filter((id) => !after.has(id));
      if (gone.length) dropped = gone;
    }

    for (const effect of tr.effects) {
      if (effect.is(setChecks)) {
        set = buildSet(effect.value, lit);
        dropped = [];
      } else if (effect.is(addCheck)) {
        const check = effect.value;
        if (check.from < check.to) {
          set = set.update({ add: [markFor(check, lit).range(check.from, check.to)], sort: true });
        }
      } else if (effect.is(removeCheck)) {
        set = set.update({ filter: (_f, _t, value) => value.spec.id !== effect.value });
      } else if (effect.is(litCheck)) {
        lit = effect.value;
        // Only the classes change; the positions are the mapped ones.
        set = buildSet(checksIn(set), lit);
      }
    }

    return { set, dropped, lit };
  },

  provide: (field) => EditorView.decorations.from(field, (value) => value.set),
});
