/* Offsets into a card's note.
 *
 * A question about a card is anchored to offsets into the stored body string,
 * so the arithmetic below is what keeps a nested highlight on the words it was
 * drawn around. It is worth asserting for the same reason the document
 * anchoring is: getting it wrong puts a check on the wrong sentence.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { offsetsFromSelection, paragraphsOf, segmentsFor, type Mark } from './body';

test('a one-paragraph note starts where the string does', () => {
  assert.deepEqual(paragraphsOf('It makes ATP.'), [{ text: 'It makes ATP.', start: 0 }]);
});

test('a blank line splits, and the second paragraph knows its offset', () => {
  const body = 'First point.\n\nSecond point.';
  const paragraphs = paragraphsOf(body);

  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[1]!.start, 14);
  assert.equal(body.slice(paragraphs[1]!.start), 'Second point.');
});

test('a single newline is not a paragraph break', () => {
  assert.equal(paragraphsOf('One line\nand its continuation.').length, 1);
});

test('every paragraph offset addresses the original string', () => {
  const body = 'Alpha.\n\n\nBeta.\n\nGamma.';
  for (const p of paragraphsOf(body)) {
    assert.equal(body.slice(p.start, p.start + p.text.length), p.text);
  }
});

test('a run of blank lines is spacing, not an empty paragraph', () => {
  assert.deepEqual(paragraphsOf('Alpha.\n\n\n\n\nBeta.').map((p) => p.text), ['Alpha.', 'Beta.']);
});

test('an empty note has no paragraphs', () => {
  assert.deepEqual(paragraphsOf(''), []);
  assert.deepEqual(paragraphsOf('\n\n  \n'), []);
});

const mark = (over: Partial<Mark> = {}): Mark => ({
  id: 'n1', from: 3, to: 8, verdict: null, ...over,
});

test('a note with no questions on it is one plain run', () => {
  const [para] = paragraphsOf('It makes ATP.');
  assert.deepEqual(segmentsFor(para!, []), [
    { text: 'It makes ATP.', checkId: null, verdict: null },
  ]);
});

test('a highlight cuts the paragraph into three runs', () => {
  const [para] = paragraphsOf('It makes ATP.');
  const segments = segmentsFor(para!, [mark({ from: 3, to: 8, verdict: 'solid' })]);

  assert.deepEqual(segments, [
    { text: 'It ', checkId: null, verdict: null },
    { text: 'makes', checkId: 'n1', verdict: 'solid' },
    { text: ' ATP.', checkId: null, verdict: null },
  ]);
});

test('the runs always reassemble into the paragraph', () => {
  const [para] = paragraphsOf('It makes ATP, mostly.');
  const segments = segmentsFor(para!, [
    mark({ id: 'a', from: 0, to: 2 }),
    mark({ id: 'b', from: 13, to: 21 }),
  ]);

  assert.equal(segments.map((s) => s.text).join(''), para!.text);
});

test('a highlight in the second paragraph is clipped to it', () => {
  const body = 'First point.\n\nSecond point.';
  const [first, second] = paragraphsOf(body);

  // Offsets 14-20 are 'Second', which lives only in the second paragraph.
  const marks = [mark({ from: 14, to: 20 })];
  assert.deepEqual(segmentsFor(first!, marks), [
    { text: 'First point.', checkId: null, verdict: null },
  ]);
  assert.equal(segmentsFor(second!, marks)[0]!.text, 'Second');
});

test('a highlight spanning a paragraph break shows in both', () => {
  const body = 'First point.\n\nSecond point.';
  const [first, second] = paragraphsOf(body);
  const marks = [mark({ from: 6, to: 20 })];

  assert.equal(segmentsFor(first!, marks).at(-1)!.checkId, 'n1');
  assert.equal(segmentsFor(second!, marks)[0]!.checkId, 'n1');
});

test('an overlapping question is skipped rather than nested', () => {
  // Two checks on the same words would put one run under both.
  const [para] = paragraphsOf('It makes ATP.');
  const segments = segmentsFor(para!, [
    mark({ id: 'a', from: 3, to: 8 }),
    mark({ id: 'b', from: 5, to: 12 }),
  ]);

  assert.deepEqual(segments.filter((s) => s.checkId).map((s) => s.checkId), ['a']);
  assert.equal(segments.map((s) => s.text).join(''), para!.text);
});

test('marks are drawn in document order however they were recorded', () => {
  const [para] = paragraphsOf('It makes ATP.');
  const segments = segmentsFor(para!, [
    mark({ id: 'late', from: 9, to: 12 }),
    mark({ id: 'early', from: 0, to: 2 }),
  ]);

  assert.deepEqual(segments.filter((s) => s.checkId).map((s) => s.checkId), ['early', 'late']);
});

/* ---------- reading a selection back ---------- */

const node = (name: string) => ({ name }) as unknown as Node;

test('a selection inside one run maps back to the body string', () => {
  const a = node('run-at-10');
  const found = offsetsFromSelection(
    { anchorNode: a, anchorOffset: 2, focusNode: a, focusOffset: 7 },
    (n) => (n === a ? 10 : null),
  );

  assert.deepEqual(found, { from: 12, to: 17 });
});

test('a selection dragged backwards is still a forward span', () => {
  const a = node('run-at-10');
  const found = offsetsFromSelection(
    { anchorNode: a, anchorOffset: 7, focusNode: a, focusOffset: 2 },
    () => 10,
  );

  assert.deepEqual(found, { from: 12, to: 17 });
});

test('a selection across two runs spans both', () => {
  const a = node('a');
  const b = node('b');
  const found = offsetsFromSelection(
    { anchorNode: a, anchorOffset: 1, focusNode: b, focusOffset: 3 },
    (n) => (n === a ? 0 : n === b ? 20 : null),
  );

  assert.deepEqual(found, { from: 1, to: 23 });
});

test('a caret is not a span', () => {
  const a = node('a');
  assert.equal(
    offsetsFromSelection({ anchorNode: a, anchorOffset: 4, focusNode: a, focusOffset: 4 }, () => 0),
    null,
  );
});

test('a selection outside any rendered body is not ours', () => {
  assert.equal(
    offsetsFromSelection({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 }, () => null),
    null,
  );
});
