/* A thread is stored as a tree and sent as a line. These pin which line: what
 * a question is asked in the light of, in what order, and what is kept out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StoredCheck } from '../store/format';
import { conversationFor, lineOf } from './conversation';

function entry(over: Partial<StoredCheck> & { id: string }): StoredCheck {
  return { from: 0, to: 0, quote: '', verdict: null, body: '', parentId: null, ...over };
}

function noteOf(...checks: StoredCheck[]): Map<string, StoredCheck> {
  return new Map(checks.map((c) => [c.id, c]));
}

const CHECK = entry({
  id: 'check',
  from: 4,
  to: 17,
  quote: 'mitochondrion',
  verdict: 'imprecise',
  body: 'It is an organelle, not a cell.',
});

test('a question put to the whole note is sent as it was typed', () => {
  const note = noteOf(entry({ id: 'q', question: 'What did I leave out?' }));

  assert.deepEqual(conversationFor(note, 'q'), [{ role: 'user', text: 'What did I leave out?' }]);
});

test('a question about a span of the note quotes the span and says whose it is', () => {
  const note = noteOf(
    entry({ id: 'q', from: 4, to: 17, quote: 'mitochondrion', question: 'Is this the right word?' }),
  );

  const [turn] = conversationFor(note, 'q');
  assert.match(turn!.text, /span of my explanation/);
  assert.match(turn!.text, /<span>\nmitochondrion\n<\/span>/);
  assert.match(turn!.text, /Is this the right word\?$/);
});

test('a follow-up under a check arrives after the check and its verdict', () => {
  const note = noteOf(CHECK, entry({ id: 'q', parentId: 'check', question: 'Why does that matter?' }));

  const turns = conversationFor(note, 'q');
  assert.deepEqual(
    turns.map((t) => t.role),
    ['user', 'assistant', 'user'],
  );
  assert.match(turns[0]!.text, /asked you to check it/);
  assert.match(turns[0]!.text, /mitochondrion/);
  assert.equal(turns[1]!.text, 'Verdict: imprecise.\n\nIt is an organelle, not a cell.');
  assert.equal(turns[2]!.text, 'Why does that matter?');
});

test('a follow-up leans on the follow-ups before it, and not on the ones after', () => {
  const note = noteOf(
    CHECK,
    entry({ id: 'q1', parentId: 'check', question: 'Why?', body: 'Because of the membrane.' }),
    entry({ id: 'q2', parentId: 'check', question: 'Which membrane?' }),
    entry({ id: 'q3', parentId: 'check', question: 'Later.', body: 'A later answer.' }),
  );

  assert.deepEqual(
    lineOf(note, 'q2').map((c) => c.id),
    ['check', 'q1', 'q2'],
  );
  assert.deepEqual(
    conversationFor(note, 'q2').map((t) => t.text).slice(2),
    ['Why?', 'Because of the membrane.', 'Which membrane?'],
  );
});

test('a question about a span of an answer is a branch, and brings only its ancestors', () => {
  const note = noteOf(
    CHECK,
    entry({ id: 'q1', parentId: 'check', question: 'Why?', body: 'Because of the membrane.' }),
    entry({ id: 'branch', parentId: 'check', from: 9, to: 18, quote: 'organelle', question: 'Meaning?' }),
  );

  assert.deepEqual(
    lineOf(note, 'branch').map((c) => c.id),
    ['check', 'branch'],
  );
  assert.match(conversationFor(note, 'branch').at(-1)!.text, /span of your reply/);
});

test('a question under a follow-up carries the conversation that follow-up was part of', () => {
  const note = noteOf(
    CHECK,
    entry({ id: 'q1', parentId: 'check', question: 'Why?', body: 'Because of the membrane.' }),
    entry({ id: 'q2', parentId: 'check', question: 'Which?', body: 'The inner one.' }),
    entry({ id: 'deep', parentId: 'q2', from: 4, to: 9, quote: 'inner', question: 'As opposed to?' }),
  );

  assert.deepEqual(
    lineOf(note, 'deep').map((c) => c.id),
    ['check', 'q1', 'q2', 'deep'],
  );
});

test('a placeholder or an error is never replayed as something Claude said', () => {
  const note = noteOf(
    entry({ id: 'demo', from: 4, to: 17, quote: 'mitochondrion', body: 'No checker is connected.' }),
    entry({ id: 'q1', parentId: 'demo', question: 'Why?', body: 'Rate limited.', failed: true }),
    entry({ id: 'q2', parentId: 'demo', question: 'Never came back.' }),
    entry({ id: 'q3', parentId: 'demo', question: 'And now?' }),
  );

  // The unassessed check, the failed question and the unanswered one all drop
  // out whole, so the roles still alternate and nothing is left hanging.
  assert.deepEqual(conversationFor(note, 'q3'), [{ role: 'user', text: 'And now?' }]);
});

test('retrying a question does not send its own old answer back', () => {
  const note = noteOf(entry({ id: 'q', question: 'Why?', body: 'An earlier answer.' }));

  assert.deepEqual(conversationFor(note, 'q'), [{ role: 'user', text: 'Why?' }]);
});

test('a question that is not in the note, or a chain that loops, sends nothing rather than hanging', () => {
  assert.deepEqual(conversationFor(noteOf(CHECK), 'gone'), []);

  const looped = noteOf(
    entry({ id: 'a', parentId: 'b', question: 'A?' }),
    entry({ id: 'b', parentId: 'a', question: 'B?' }),
  );
  assert.equal(conversationFor(looped, 'a').at(-1)!.text, 'A?');
});
