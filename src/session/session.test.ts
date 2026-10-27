/* The join between the store and the decorations.
 *
 * The store gets a map for a disk and the broadcaster records what it was
 * told, so every assertion here is about the thing that is actually hard:
 * which checks are drawn, where they sit after the text moves, and what
 * survives a span being deleted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Check as LiveCheck } from '../anchor/field';
import type { StoredCheck } from '../store/format';
import { CheckStore, type StoreAdapter } from '../store/store';
import {
  CheckSession,
  anchorAll,
  childrenOf,
  liveChecks,
  noteChecks,
  unanchoredChecks,
} from './session';

const DOC = 'The mitochondrion is the powerhouse of the cell, as everyone knows.';

function memoryAdapter(): StoreAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) {
      const found = files.get(path);
      if (found === undefined) throw new Error(`no such file: ${path}`);
      return found;
    },
    async write(path, data) {
      files.set(path, data);
    },
    async exists(path) {
      return files.has(path);
    },
    async remove(path) {
      files.delete(path);
    },
    async mkdir() {},
    async list() {
      return { files: [...files.keys()], folders: [] };
    },
  };
}

class RecordingViews {
  drawn = new Map<string, readonly LiveCheck[]>();
  litIds: (string | null)[] = [];

  setChecks(path: string, checks: readonly LiveCheck[]): void {
    this.drawn.set(path, checks);
  }

  lit(_path: string, id: string | null): void {
    this.litIds.push(id);
  }

  for(path: string): readonly LiveCheck[] {
    return this.drawn.get(path) ?? [];
  }
}

/** A store that writes the moment it is asked, so a test never waits out the
 *  debounce to see what would have landed on disk. */
function harness() {
  const adapter = memoryAdapter();
  const store = new CheckStore(adapter, 'checks', 0);
  const views = new RecordingViews();
  let seq = 0;
  const session = new CheckSession(store, views, () => `c${++seq}`);
  return { adapter, store, views, session };
}

function stored(over: Partial<StoredCheck> = {}): StoredCheck {
  return {
    id: 'c1',
    from: 4,
    to: 17,
    quote: 'mitochondrion',
    verdict: 'solid',
    body: 'Correct.',
    parentId: null,
    ...over,
  };
}

test('a check whose text still stands keeps its offsets', () => {
  const note = anchorAll('n.md', [stored()], DOC);
  assert.deepEqual(liveChecks(note), [
    { id: 'c1', from: 4, to: 17, verdict: 'solid' },
  ]);
  assert.equal(unanchoredChecks(note).length, 0);
});

test('a check whose offsets have shifted is found by its quote', () => {
  // Two words inserted at the front: the stored offsets now point at the
  // wrong text, and only the quote can say where the span went.
  const moved = `Everyone says ${DOC}`;
  const note = anchorAll('n.md', [stored()], moved);

  assert.deepEqual(liveChecks(note), [
    { id: 'c1', from: 18, to: 31, verdict: 'solid' },
  ]);
  assert.equal(moved.slice(18, 31), 'mitochondrion');
});

test('a check whose text is gone is kept, not drawn', () => {
  const note = anchorAll('n.md', [stored()], 'Something else entirely.');

  assert.deepEqual(liveChecks(note), []);
  assert.deepEqual(
    unanchoredChecks(note).map((c) => c.id),
    ['c1'],
  );
  // The record and its assessment survive losing the span.
  assert.equal(note.byId.get('c1')?.body, 'Correct.');
});

test('offsets that still hold the right text are trusted over a repeated quote', () => {
  // 'the cell' appears twice, but the stored span is sitting on the one this
  // check was written about. Searching would only introduce doubt.
  const twice = 'the cell, and again the cell.';
  const note = anchorAll('n.md', [stored({ quote: 'the cell', from: 0, to: 8 })], twice);

  assert.deepEqual(liveChecks(note), [{ id: 'c1', from: 0, to: 8, verdict: 'solid' }]);
});

test('a check whose quote appears twice is left unplaced rather than guessed', () => {
  // Now the offsets no longer fit, so the quote is all we have — and it
  // cannot say which of the two spans was meant.
  const twice = 'Note: the cell, and again the cell.';
  const note = anchorAll('n.md', [stored({ quote: 'the cell', from: 0, to: 8 })], twice);

  assert.notEqual(twice.slice(0, 8), 'the cell');
  assert.deepEqual(liveChecks(note), []);
  assert.deepEqual(
    unanchoredChecks(note).map((c) => c.id),
    ['c1'],
  );
});

test('nested checks are never drawn in the editor', () => {
  const note = anchorAll(
    'n.md',
    [stored(), stored({ id: 'c2', parentId: 'c1', quote: 'Correct', from: 0, to: 7 })],
    DOC,
  );

  assert.deepEqual(
    liveChecks(note).map((c) => c.id),
    ['c1'],
  );
  // It is still on record — it just anchors into its parent's note, not the doc.
  assert.equal(note.byId.get('c2')?.parentId, 'c1');
  assert.deepEqual(
    noteChecks(note).map((c) => c.id),
    ['c1'],
  );
});

test('opening a note draws its stored checks', async () => {
  const { store, views, session } = harness();
  await store.save('n.md', [stored()]);

  await session.open('n.md', DOC);

  assert.deepEqual(views.for('n.md'), [{ id: 'c1', from: 4, to: 17, verdict: 'solid' }]);
});

test('opening a note again redraws it, for a second editor on the same file', async () => {
  const { store, views, session } = harness();
  await store.save('n.md', [stored()]);

  await session.open('n.md', DOC);
  views.drawn.clear();
  await session.open('n.md', DOC);

  assert.equal(views.for('n.md').length, 1);
});

test('opening a note costs no write when nothing needed repairing', async () => {
  const { adapter, store, session } = harness();
  await store.save('n.md', [stored()]);
  const before = [...adapter.files.values()][0];

  await session.open('n.md', DOC);
  await store.flush();

  assert.equal([...adapter.files.values()][0], before);
});

test('an offset repaired on open is written back', async () => {
  const { adapter, store, session } = harness();
  await store.save('n.md', [stored()]);

  // The note gained a sentence while the plugin was not watching.
  await session.open('n.md', `Everyone says ${DOC}`);
  await store.flush();

  const written = JSON.parse([...adapter.files.values()][0]!) as { checks: StoredCheck[] };
  assert.equal(written.checks[0]!.from, 18);
});

test('an edit that moves a span updates what is stored', async () => {
  const { adapter, store, session } = harness();
  await store.save('n.md', [stored()]);
  await session.open('n.md', DOC);

  session.moved('n.md', [{ id: 'c1', from: 18, to: 31, verdict: 'solid' }]);
  await store.flush();

  const written = JSON.parse([...adapter.files.values()][0]!) as { checks: StoredCheck[] };
  assert.equal(written.checks[0]!.from, 18);
  assert.equal(written.checks[0]!.to, 31);
});

test('a deleted span marks its check unanchored without deleting it', async () => {
  const { store, session } = harness();
  await store.save('n.md', [stored()]);
  const note = await session.open('n.md', DOC);

  session.dropped('n.md', ['c1']);

  assert.equal(note.byId.get('c1')?.unanchored, true);
  assert.equal(note.byId.get('c1')?.body, 'Correct.');
  assert.deepEqual(liveChecks(note), []);
});

test('re-anchoring puts a check back when its text returns', async () => {
  const { store, session } = harness();
  await store.save('n.md', [stored()]);
  const note = await session.open('n.md', 'Nothing like it here.');
  assert.equal(unanchoredChecks(note).length, 1);

  const result = session.reanchor('n.md', DOC);

  assert.deepEqual(result, { placed: 1, stuck: 0 });
  assert.deepEqual(liveChecks(note), [{ id: 'c1', from: 4, to: 17, verdict: 'solid' }]);
});

test('re-anchoring reports what it could not place', async () => {
  const { store, session } = harness();
  await store.save('n.md', [stored()]);
  await session.open('n.md', 'Nothing like it here.');

  assert.deepEqual(session.reanchor('n.md', 'Still nothing.'), { placed: 0, stuck: 1 });
});

test('a new check is drawn and saved straight away', async () => {
  const { adapter, store, views, session } = harness();

  const check = session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });
  await store.flush();

  assert.equal(check.verdict, null, 'nothing has assessed it yet');
  assert.deepEqual(views.for('n.md'), [{ id: 'c1', from: 4, to: 17, verdict: null }]);
  const written = JSON.parse([...adapter.files.values()][0]!) as { checks: StoredCheck[] };
  assert.equal(written.checks[0]!.id, 'c1');
});

test('an assessment repaints the highlight with its verdict', async () => {
  const { views, session } = harness();
  const check = session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });

  session.assessed('n.md', check.id, 'imprecise', 'It makes ATP, but that is not all it does.');

  assert.deepEqual(views.for('n.md'), [{ id: 'c1', from: 4, to: 17, verdict: 'imprecise' }]);
});

test('a failed check keeps its highlight and stays unlabelled', async () => {
  const { session } = harness();
  const check = session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });

  session.assessed('n.md', check.id, null, 'The check could not be completed.');

  const note = session.peek('n.md')!;
  assert.equal(note.byId.get(check.id)?.verdict, null);
  assert.equal(liveChecks(note).length, 1, 'the span stays marked so it can be retried');
});

test('resolving keeps the record and drops the highlight', async () => {
  const { views, session } = harness();
  const check = session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });

  session.resolve('n.md', check.id);

  assert.deepEqual(views.for('n.md'), []);
  assert.equal(session.peek('n.md')!.byId.get(check.id)?.resolved, true);
});

test('dismissing takes the thread hanging off it', async () => {
  const { session } = harness();
  const root = session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });
  const child = session.add('n.md', { span: { from: 0, to: 3, quote: 'ATP' }, parentId: root.id });
  const grandchild = session.add('n.md', { span: { from: 0, to: 2, quote: 'AT' }, parentId: child.id });

  session.remove('n.md', root.id);

  const note = session.peek('n.md')!;
  assert.equal(note.byId.size, 0, 'a question about a deleted note has nothing left to mean');
  assert.equal(note.byId.has(grandchild.id), false);
});

test('dismissing one check leaves its siblings alone', async () => {
  const { session } = harness();
  const first = session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });
  const second = session.add('n.md', { span: { from: 25, to: 35, quote: 'powerhouse' } });

  session.remove('n.md', first.id);

  assert.deepEqual([...session.peek('n.md')!.byId.keys()], [second.id]);
});

test('the leaf hears about a change to the note it is showing', async () => {
  const { session } = harness();
  const seen: string[] = [];
  session.onChange((path) => seen.push(path));

  session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });

  assert.deepEqual(seen, ['n.md']);
});

test('a moved offset raises no event, because the leaf does not show offsets', async () => {
  const { store, session } = harness();
  await store.save('n.md', [stored()]);
  await session.open('n.md', DOC);

  let events = 0;
  session.onChange(() => (events += 1));
  session.moved('n.md', [{ id: 'c1', from: 18, to: 31, verdict: 'solid' }]);

  assert.equal(events, 0, 'otherwise this is a re-render per keystroke');
});

test('unsubscribing stops the events', async () => {
  const { session } = harness();
  let events = 0;
  const off = session.onChange(() => (events += 1));

  off();
  session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });

  assert.equal(events, 0);
});

test('a renamed note keeps its loaded checks under the new path', async () => {
  const { session } = harness();
  const check = session.add('old.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });

  session.renamed('old.md', 'new.md');

  assert.equal(session.peek('old.md'), null);
  assert.equal(session.peek('new.md')?.byId.get(check.id)?.quote, 'mitochondrion');
});

test('a note whose file could not be read is never written over', async () => {
  const { adapter, store, session } = harness();
  await store.save('n.md', [stored()]);
  const [file] = [...adapter.files.keys()];
  adapter.files.set(file!, '{ this is not json');

  await session.open('n.md', DOC);
  session.add('n.md', { span: { from: 25, to: 35, quote: 'powerhouse' } });
  await store.flush();

  assert.equal(adapter.files.get(file!), '{ this is not json');
  assert.equal(store.isUnreadable('n.md'), true);
});

/* ---------- questions ---------- */

test('a question put to the whole note is recorded, and draws nothing in the prose', async () => {
  const { adapter, session, views } = harness();
  await session.open('n.md', DOC);
  const asked = session.add('n.md', { question: 'What did I leave out?' });
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(views.for('n.md'), []);
  assert.equal(noteChecks(session.peek('n.md')!).length, 1);
  const [saved] = JSON.parse([...adapter.files.values()][0]!).checks;
  assert.equal(saved.id, asked.id);
  assert.equal(saved.question, 'What did I leave out?');
});

test('a question with no span is not mistaken for a check that lost its span', () => {
  const asked = stored({ from: 0, to: 0, quote: '', verdict: null, question: 'Why?', body: 'Because.' });
  const note = anchorAll('n.md', [asked], DOC);

  assert.equal(unanchoredChecks(note).length, 0);
  assert.deepEqual(liveChecks(note), []);
  assert.deepEqual(note.byId.get('c1'), asked);
});

test('a question about a span is highlighted, and stays neutral once answered', async () => {
  const { session, views } = harness();
  await session.open('n.md', DOC);
  const asked = session.add('n.md', {
    span: { from: 4, to: 17, quote: 'mitochondrion' },
    question: 'Is this the right word?',
  });
  session.answered('n.md', asked.id, 'It is.', false);

  assert.deepEqual(views.for('n.md'), [{ id: asked.id, from: 4, to: 17, verdict: null }]);
  assert.equal(session.peek('n.md')!.byId.get(asked.id)!.body, 'It is.');
});

test('an answer that is not one is marked, and a retry that works clears the mark', async () => {
  const { adapter, session } = harness();
  await session.open('n.md', DOC);
  const asked = session.add('n.md', { question: 'Why?' });

  session.answered('n.md', asked.id, 'Rate limited.', true);
  assert.equal(session.peek('n.md')!.byId.get(asked.id)!.failed, true);

  session.answered('n.md', asked.id, 'Because.', false);
  await new Promise((r) => setTimeout(r, 5));
  const [saved] = JSON.parse([...adapter.files.values()][0]!).checks;
  assert.equal(saved.body, 'Because.');
  assert.equal('failed' in saved, false, 'the absent key and the false one mean the same thing');
});

test('follow-ups hang off their card in the order they were asked, and go with it', async () => {
  const { session } = harness();
  await session.open('n.md', DOC);
  const root = session.add('n.md', { span: { from: 4, to: 17, quote: 'mitochondrion' } });
  const first = session.add('n.md', { parentId: root.id, question: 'Why?' });
  const second = session.add('n.md', { parentId: root.id, question: 'And then?' });

  const note = session.peek('n.md')!;
  assert.deepEqual(
    childrenOf(note, root.id).map((c) => c.id),
    [first.id, second.id],
  );
  assert.equal(noteChecks(note).length, 1, 'a follow-up is not a card in the list');

  session.remove('n.md', root.id);
  assert.equal(session.peek('n.md')!.byId.size, 0);
});
