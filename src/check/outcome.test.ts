import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CheckerError } from '../checker/protocol';
import {
  demoOutcome,
  demoReply,
  failureOutcome,
  failureReply,
  inFrontmatter,
  pageText,
  trim,
} from './outcome';

test('demo mode says it is not an assessment, and quotes the span', () => {
  const { verdict, body } = demoOutcome('the mitochondrion');

  assert.equal(verdict, null, 'nothing read it, so nothing labels it');
  assert.match(body, /placeholder/);
  assert.match(body, /the mitochondrion/);
  assert.match(body, /settings/);
});

test('a long quote is trimmed rather than filling the card', () => {
  const { body } = demoOutcome('x'.repeat(200));

  assert.match(body, /…/);
  assert.equal(body.includes('x'.repeat(61)), false);
});

test('a missing key reads as demo mode, not as a failed check', () => {
  const outcome = failureOutcome(CheckerError.notConnected(), 'a span');

  assert.deepEqual(outcome, demoOutcome('a span'));
});

test('a real failure says what went wrong and that the highlight is safe', () => {
  const outcome = failureOutcome(new CheckerError('rate_limited', 'Rate limited by the API.'), 'a span');

  assert.equal(outcome.verdict, null);
  assert.match(outcome.body, /Rate limited by the API\./);
  assert.match(outcome.body, /try again/);
});

test('a failure that is not an Error still produces a card', () => {
  const outcome = failureOutcome('something odd', 'a span');

  assert.equal(outcome.verdict, null);
  assert.match(outcome.body, /could not be completed/);
});

test('frontmatter is not part of the page Claude reads', () => {
  const doc = '---\ntitle: Cells\n---\n\nThe mitochondrion makes ATP.';

  assert.equal(pageText(doc, 20), 'The mitochondrion makes ATP.');
});

test('a note without frontmatter is sent whole', () => {
  assert.equal(pageText('The mitochondrion makes ATP.'), 'The mitochondrion makes ATP.');
});

test('a frontmatter offset past the end of the note does not throw', () => {
  assert.equal(pageText('short', 9999), '');
});

test('a span inside frontmatter is recognised, and one after it is not', () => {
  assert.equal(inFrontmatter(6, 20), true);
  assert.equal(inFrontmatter(25, 20), false);
  assert.equal(inFrontmatter(0, 0), false, 'a note with no frontmatter has no such span');
});

test('trimming collapses the whitespace a selection picks up', () => {
  assert.equal(trim('  the   cell \n knows ', 40), 'the cell knows');
});

test('demo mode the reader chose does not claim nothing is connected', () => {
  const { verdict, body } = demoOutcome('the mitochondrion', 'chosen');

  assert.equal(verdict, null);
  assert.match(body, /Demo mode is on/);
  assert.equal(body.includes('No checker is connected'), false);
  assert.match(body, /highlight is saved/);
});

test('the two demo reasons say different things', () => {
  assert.notEqual(demoOutcome('a span', 'chosen').body, demoOutcome('a span', 'no-key').body);
});

test('a question nothing read is marked as not an answer, and says what to do', () => {
  const noKey = demoReply();
  assert.equal(noKey.failed, true);
  assert.match(noKey.body, /placeholder/);
  assert.match(noKey.body, /API key/);

  const chosen = demoReply('chosen');
  assert.equal(chosen.failed, true);
  assert.match(chosen.body, /Demo mode is on/);
});

test('a question that failed says why, and that it is saved', () => {
  const reply = failureReply(new CheckerError('rate_limited', 'Rate limited by the API.'));

  assert.equal(reply.failed, true);
  assert.match(reply.body, /Rate limited/);
  assert.match(reply.body, /question is saved/);
  assert.deepEqual(failureReply(CheckerError.notConnected()), demoReply());
});
