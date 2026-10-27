/* What the desktop app fought for three commits, asserted against the
 * framework that is supposed to handle it. These run on plain CM6 with no
 * Obsidian and no DOM — the editor state is real, only the rendering is
 * absent, and none of this is about rendering. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EditorState, type StateEffect } from '@codemirror/state';

import {
  addCheck,
  checkField,
  checksIn,
  litCheck,
  removeCheck,
  setChecks,
  type Check,
} from './field';

const PAGE = 'Encapsulation hides state behind an interface. Inheritance shares code.';
//           0123456789...
const SPAN = { from: 0, to: 14 }; // "Encapsulation "... exactly "Encapsulation"
const check = (over: Partial<Check> = {}): Check => ({
  id: 'c1',
  from: 0,
  to: 13, // "Encapsulation"
  verdict: 'solid',
  ...over,
});

function stateWith(checks: Check[], doc = PAGE): EditorState {
  const state = EditorState.create({ doc, extensions: [checkField] });
  return state.update({ effects: setChecks.of(checks) }).state;
}

function ranges(state: EditorState): Array<{ id: string; from: number; to: number }> {
  return checksIn(state.field(checkField).set).map(({ id, from, to }) => ({ id, from, to }));
}

function apply(
  state: EditorState,
  changes: { from: number; to?: number; insert?: string },
  effects?: StateEffect<unknown>[],
): EditorState {
  return state.update({ changes, effects }).state;
}

test('a highlight follows its text when the user types above it', () => {
  const before = stateWith([check({ from: 47, to: 58 })]); // "Inheritance"
  assert.deepEqual(ranges(before), [{ id: 'c1', from: 47, to: 58 }]);

  const after = apply(before, { from: 0, insert: 'A note first.\n' });
  assert.deepEqual(ranges(after), [{ id: 'c1', from: 61, to: 72 }]);
  assert.equal(after.doc.sliceString(61, 72), 'Inheritance');
});

test('typing at the end of a highlight stays outside it', () => {
  // The bug `fixHighlightBoundary` and `data-len` existed to prevent: on the
  // other surfaces the browser absorbed the new text into the mark.
  const before = stateWith([check()]);
  const after = apply(before, { from: 13, insert: ' really' });

  assert.deepEqual(ranges(after), [{ id: 'c1', from: 0, to: 13 }]);
  assert.equal(after.doc.sliceString(0, 13), 'Encapsulation');
});

test('typing at the start of a highlight stays outside it', () => {
  const before = stateWith([check()]);
  const after = apply(before, { from: 0, insert: 'Strong ' });

  assert.deepEqual(ranges(after), [{ id: 'c1', from: 7, to: 20 }]);
  assert.equal(after.doc.sliceString(7, 20), 'Encapsulation');
});

test('editing inside a highlight grows it', () => {
  const before = stateWith([check()]);
  const after = apply(before, { from: 5, insert: 'XYZ' });

  assert.deepEqual(ranges(after), [{ id: 'c1', from: 0, to: 16 }]);
});

test('deleting a checked span drops the decoration and says which one', () => {
  const before = stateWith([check()]);
  const after = apply(before, { from: 0, to: 13, insert: '' });

  assert.deepEqual(ranges(after), []);
  assert.deepEqual(after.field(checkField).dropped, ['c1']);
});

test('undoing that deletion does not resurrect the highlight', () => {
  // The rule this pins: losing a decoration is not losing the check. The
  // record lives in plugin data and is re-anchored from its quote; nothing
  // about CM6 brings the mark back on its own.
  const deleted = apply(stateWith([check()]), { from: 0, to: 13, insert: '' });
  const undone = apply(deleted, { from: 0, insert: 'Encapsulation' });

  assert.equal(undone.doc.toString(), PAGE);
  assert.deepEqual(ranges(undone), []);
});

test('dropped is an event, not a running total', () => {
  const dropped = apply(stateWith([check()]), { from: 0, to: 13, insert: '' });
  assert.deepEqual(dropped.field(checkField).dropped, ['c1']);

  const later = apply(dropped, { from: 0, insert: 'x' });
  assert.deepEqual(later.field(checkField).dropped, []);
});

test('an edit elsewhere drops nothing', () => {
  const after = apply(stateWith([check()]), { from: PAGE.length, insert: ' More.' });
  assert.deepEqual(after.field(checkField).dropped, []);
  assert.deepEqual(ranges(after), [{ id: 'c1', from: 0, to: 13 }]);
});

test('several checks on one note are kept in document order', () => {
  const state = stateWith([
    check({ id: 'late', from: 47, to: 58 }),
    check({ id: 'early', from: 0, to: 13 }),
  ]);
  assert.deepEqual(
    ranges(state).map((r) => r.id),
    ['early', 'late'],
  );
});

test('checks can be added and removed one at a time', () => {
  const one = stateWith([check()]);
  const two = one.update({ effects: addCheck.of(check({ id: 'c2', from: 47, to: 58 })) }).state;
  assert.deepEqual(
    ranges(two).map((r) => r.id),
    ['c1', 'c2'],
  );

  const back = two.update({ effects: removeCheck.of('c1') }).state;
  assert.deepEqual(
    ranges(back).map((r) => r.id),
    ['c2'],
  );
});

test('a verdict paints its own class, and no verdict paints neutral', () => {
  const state = stateWith([
    check({ id: 'w', from: 0, to: 13, verdict: 'wrong' }),
    check({ id: 'n', from: 47, to: 58, verdict: null }),
  ]);
  const set = state.field(checkField).set;
  const classes: string[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    classes.push(cursor.value.spec.class as string);
    cursor.next();
  }

  assert.ok(classes[0]!.includes('recall-wrong'));
  assert.ok(classes[1]!.includes('recall-unassessed'));
  assert.ok(!classes[1]!.includes('recall-null'));
});

test('lighting a check re-paints only that one, in place', () => {
  const state = stateWith([
    check({ id: 'c1', from: 0, to: 13 }),
    check({ id: 'c2', from: 47, to: 58 }),
  ]);
  const lit = state.update({ effects: litCheck.of('c2') }).state;

  const set = lit.field(checkField).set;
  const found: Array<[string, boolean]> = [];
  const cursor = set.iter();
  while (cursor.value) {
    found.push([cursor.value.spec.id as string, (cursor.value.spec.class as string).includes('is-lit')]);
    cursor.next();
  }

  assert.deepEqual(found, [['c1', false], ['c2', true]]);
  // Positions survive the repaint.
  assert.deepEqual(ranges(lit), [
    { id: 'c1', from: 0, to: 13 },
    { id: 'c2', from: 47, to: 58 },
  ]);
});

test('a lit highlight keeps its light through an edit', () => {
  const lit = stateWith([check()]).update({ effects: litCheck.of('c1') }).state;
  const after = apply(lit, { from: PAGE.length, insert: '!' });

  const cursor = after.field(checkField).set.iter();
  assert.ok((cursor.value!.spec.class as string).includes('is-lit'));
});

test('a zero-length check is never anchored in the first place', () => {
  // Anchoring happens before the check is recorded on the other surfaces, and
  // refuses out loud if it cannot. An empty range is the same refusal here.
  const state = stateWith([check({ from: 5, to: 5 })]);
  assert.deepEqual(ranges(state), []);
  assert.equal(SPAN.to > SPAN.from, true);
});
