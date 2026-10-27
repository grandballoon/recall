import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fileNameFor,
  hasSpan,
  isAnswered,
  isFollowUp,
  parseNoteFile,
  serialiseNoteFile,
  FORMAT_VERSION,
  type StoredCheck,
} from './format';

const NOTE = 'notes/encapsulation.md';

test('a path decides its filename, the same way every time', () => {
  assert.equal(fileNameFor(NOTE), fileNameFor(NOTE));
  assert.notEqual(fileNameFor(NOTE), fileNameFor('notes/encapsulation2.md'));
  assert.match(fileNameFor(NOTE), /^[0-9a-f]{16}\.json$/);
});

test('filenames are safe whatever the note is called', () => {
  for (const path of ['a/b/c.md', 'ünïcode ✓.md', 'with spaces & symbols!.md', '../../escape.md']) {
    assert.match(fileNameFor(path), /^[0-9a-f]{16}\.json$/);
  }
});

test('nothing saved yet is not a failure', () => {
  assert.deepEqual(parseNoteFile(null, NOTE), { kind: 'empty' });
  assert.deepEqual(parseNoteFile('   ', NOTE), { kind: 'empty' });
});

test('every way a file can be wrong is reported, and says why', () => {
  const cases: Array<[string, RegExp]> = [
    ['{oops', /not valid JSON/],
    ['[]', /not shaped like a Recall file/],
    ['"a string"', /not shaped like a Recall file/],
    [JSON.stringify({ v: 99, path: NOTE, checks: [] }), /format version 99/],
    [JSON.stringify({ v: FORMAT_VERSION, checks: [] }), /which note it belongs to/],
    [JSON.stringify({ v: FORMAT_VERSION, path: 'elsewhere.md', checks: [] }), /belongs to elsewhere\.md/],
    [JSON.stringify({ v: FORMAT_VERSION, path: NOTE, checks: [{ id: 1 }] }), /not shaped like checks/],
    [JSON.stringify({ v: FORMAT_VERSION, path: NOTE }), /not shaped like checks/],
  ];
  for (const [raw, why] of cases) {
    const result = parseNoteFile(raw, NOTE);
    assert.equal(result.kind, 'unreadable', `expected ${raw} to be unreadable`);
    assert.match(result.kind === 'unreadable' ? result.why : '', why);
  }
});

test('a good file round-trips', () => {
  const file = {
    v: FORMAT_VERSION,
    path: NOTE,
    checks: [
      { id: 'c1', from: 0, to: 13, quote: 'Encapsulation', verdict: 'solid' as const, body: 'n', parentId: null },
    ],
  };
  assert.deepEqual(parseNoteFile(serialiseNoteFile(file), NOTE), { kind: 'ok', file });
});

test('a deleted note keeps saying so', () => {
  const file = { v: FORMAT_VERSION, path: NOTE, deleted: true, checks: [] };
  const result = parseNoteFile(serialiseNoteFile(file), NOTE);
  assert.equal(result.kind === 'ok' && result.file.deleted, true);
});

/* ---------- questions ---------- */

function check(over: Partial<StoredCheck> = {}): StoredCheck {
  return { id: 'c1', from: 4, to: 17, quote: 'a span', verdict: null, body: '', parentId: null, ...over };
}

test('a question round-trips, and a question that is not text is refused', () => {
  const asked = check({ from: 0, to: 0, quote: '', question: 'Why?', body: 'Because.' });
  const raw = serialiseNoteFile({ v: FORMAT_VERSION, path: NOTE, checks: [asked] });
  const read = parseNoteFile(raw, NOTE);
  assert.deepEqual(read.kind === 'ok' ? read.file.checks : null, [asked]);

  const bad = JSON.stringify({ v: FORMAT_VERSION, path: NOTE, checks: [{ ...asked, question: 7 }] });
  assert.equal(parseNoteFile(bad, NOTE).kind, 'unreadable');
});

test('only a question with no span, asked of a card, is a follow-up', () => {
  const spanless = { from: 0, to: 0, quote: '' };
  assert.equal(isFollowUp(check({ ...spanless, question: 'Why?', parentId: 'c0' })), true);
  assert.equal(isFollowUp(check({ ...spanless, question: 'Why?' })), false, 'put to the note');
  assert.equal(isFollowUp(check({ question: 'Why?', parentId: 'c0' })), false, 'about a span');
  assert.equal(isFollowUp(check({ parentId: 'c0' })), false, 'a check');
  assert.equal(hasSpan(check(spanless)), false);
});

test('a card is answered only when Claude actually said what is on it', () => {
  assert.equal(isAnswered(check({ verdict: 'solid', body: 'Correct.' })), true);
  assert.equal(isAnswered(check({ body: 'Demo mode is on.' })), false, 'a check with no verdict');
  assert.equal(isAnswered(check({ question: 'Why?', body: 'Because.' })), true);
  assert.equal(isAnswered(check({ question: 'Why?', body: 'Rate limited.', failed: true })), false);
  assert.equal(isAnswered(check({ question: 'Why?' })), false, 'still in flight');
});
