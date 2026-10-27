/* The failure this suite exists for is the one the desktop app hit: a file
 * that could not be read, seeded over with an empty one a second later.
 * Everything else is ordinary round-tripping. The adapter is a map, so none
 * of this needs Obsidian or a disk. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CheckStore, type StoreAdapter } from './store';
import { fileNameFor, type StoredCheck } from './format';

const FOLDER = 'plugins/recall/checks';
const NOTE = 'notes/encapsulation.md';

class FakeAdapter implements StoreAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  failRead: string | null = null;
  writes = 0;

  async read(path: string): Promise<string> {
    if (this.failRead === path) throw new Error('EIO');
    const found = this.files.get(path);
    if (found === undefined) throw new Error(`ENOENT ${path}`);
    return found;
  }
  async write(path: string, data: string): Promise<void> {
    this.writes++;
    this.files.set(path, data);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return {
      files: [...this.files.keys()].filter((f) => f.startsWith(`${path}/`)),
      folders: [],
    };
  }
}

const check = (over: Partial<StoredCheck> = {}): StoredCheck => ({
  id: 'c1',
  from: 0,
  to: 13,
  quote: 'Encapsulation',
  verdict: 'solid',
  body: 'Right, and the interface is the point.',
  parentId: null,
  ...over,
});

function setup(): { adapter: FakeAdapter; store: CheckStore; file: string } {
  const adapter = new FakeAdapter();
  return {
    adapter,
    store: new CheckStore(adapter, FOLDER, 0),
    file: `${FOLDER}/${fileNameFor(NOTE)}`,
  };
}

test('checks round-trip through a note file', async () => {
  const { store } = setup();
  await store.save(NOTE, [check()]);
  assert.deepEqual(await store.load(NOTE), [check()]);
});

test('a note with nothing saved yet reads as no checks', async () => {
  const { store } = setup();
  assert.deepEqual(await store.load(NOTE), []);
  assert.equal(store.isUnreadable(NOTE), false);
});

test('a file that is not valid JSON is never written over', async () => {
  // The desktop app's failure, scoped to one note: read fails, we carry on
  // with an empty set, and a second later the empty set is on disk.
  const { adapter, store, file } = setup();
  adapter.files.set(file, '{"v":1,"path":"notes/enc');

  assert.deepEqual(await store.load(NOTE), []);
  assert.equal(store.isUnreadable(NOTE), true);

  await store.save(NOTE, [check()]);
  assert.equal(adapter.files.get(file), '{"v":1,"path":"notes/enc', 'the damaged file was overwritten');
});

test('an unrecognised format version is never written over', async () => {
  // A bumped version would otherwise wipe every file on first launch of the
  // build that bumped it.
  const { adapter, store, file } = setup();
  const future = JSON.stringify({ v: 2, path: NOTE, checks: [] });
  adapter.files.set(file, future);

  await store.save(NOTE, [check()]);
  assert.equal(adapter.files.get(file), future);
  assert.match(store.listUnreadable()[0]!.why, /format version 2/);
});

test('a filename collision is refused rather than served', async () => {
  const { adapter, store, file } = setup();
  adapter.files.set(file, JSON.stringify({ v: 1, path: 'some/other/note.md', checks: [check()] }));

  assert.deepEqual(await store.load(NOTE), []);
  assert.match(store.listUnreadable()[0]!.why, /belongs to some\/other\/note\.md/);
});

test('a read that throws is treated as unreadable, not as empty', async () => {
  const { adapter, store, file } = setup();
  adapter.files.set(file, JSON.stringify({ v: 1, path: NOTE, checks: [check()] }));
  adapter.failRead = file;

  assert.deepEqual(await store.load(NOTE), []);
  assert.equal(store.isUnreadable(NOTE), true);
});

test('a note whose last check is removed loses its file', async () => {
  const { adapter, store, file } = setup();
  await store.save(NOTE, [check()]);
  await store.save(NOTE, []);
  assert.equal(adapter.files.has(file), false);
});

test('an unanchored check round-trips as one', async () => {
  // Which checks have lost their span is the session's call; the store's job
  // is only to carry the flag intact. See session.test.ts for the transition.
  const { store } = setup();
  await store.save(NOTE, [check(), check({ id: 'c2', from: 20, to: 25, unanchored: true })]);

  const back = await store.load(NOTE);
  assert.equal(back.find((c) => c.id === 'c1')!.unanchored, undefined);
  assert.equal(back.find((c) => c.id === 'c2')!.unanchored, true);
  assert.equal(back.length, 2, 'the record has to outlive the decoration');
});

test('renaming a note moves its checks and updates what they say they are', async () => {
  const { adapter, store, file } = setup();
  await store.save(NOTE, [check()]);

  const moved = 'archive/encapsulation.md';
  await store.handleRename(NOTE, moved);

  assert.equal(adapter.files.has(file), false);
  assert.deepEqual(await store.load(moved), [check()]);
  assert.deepEqual(await store.load(NOTE), []);
});

test('renaming carries an unreadable file with the note', async () => {
  const { adapter, store, file } = setup();
  adapter.files.set(file, 'not json');
  await store.load(NOTE);

  await store.handleRename(NOTE, 'archive/enc.md');
  assert.equal(store.isUnreadable(NOTE), false);
  assert.equal(store.isUnreadable('archive/enc.md'), true);
});

test('a damaged file moves as the bytes we found, not as bytes we wrote', async () => {
  const { adapter, store, file } = setup();
  const damaged = '{"v":1,"path":"notes/enc';
  adapter.files.set(file, damaged);

  const moved = 'archive/enc.md';
  await store.handleRename(NOTE, moved);

  assert.equal(adapter.files.has(file), false);
  assert.equal(adapter.files.get(`${FOLDER}/${fileNameFor(moved)}`), damaged);
});

test('deleting a note keeps its checks, marked', async () => {
  // A delete is reversible through the trash. Deleting the assessments with
  // it is not.
  const { adapter, store, file } = setup();
  await store.save(NOTE, [check()]);
  await store.handleDelete(NOTE);

  assert.equal(adapter.files.has(file), true);
  assert.deepEqual(await store.load(NOTE), [check()]);
  assert.equal(JSON.parse(adapter.files.get(file)!).deleted, true);
});

test('a deleted note that comes back keeps its mark until asked otherwise', async () => {
  const { adapter, store, file } = setup();
  await store.save(NOTE, [check()]);
  await store.handleDelete(NOTE);
  await store.save(NOTE, [check(), check({ id: 'c2' })]);

  assert.equal(JSON.parse(adapter.files.get(file)!).deleted, true);
  assert.equal((await store.load(NOTE)).length, 2);
});

/** Nothing is at that path any more — the everyday case for a prune. */
const allGone = () => false;

test('pruning takes the deleted ones and leaves the rest', async () => {
  const { adapter, store } = setup();
  await store.save(NOTE, [check()]);
  await store.save('notes/kept.md', [check({ id: 'k1' })]);
  await store.handleDelete(NOTE);

  assert.deepEqual(await store.prune(allGone), [NOTE]);
  assert.deepEqual(await store.load('notes/kept.md'), [check({ id: 'k1' })]);
  assert.equal(adapter.files.size, 1);
});

test('pruning never removes a file it could not read', async () => {
  const { adapter, store } = setup();
  adapter.files.set(`${FOLDER}/garbage.json`, 'not json at all');
  assert.deepEqual(await store.prune(allGone), []);
  assert.equal(adapter.files.size, 1);
});

test('a note restored from the trash does not lose its checks to a prune', async () => {
  // A delete is reversible, so the flag alone is not evidence the note is
  // gone. Acting on it by itself destroys the checks of a note sitting there.
  const { store } = setup();
  await store.save(NOTE, [check()]);
  await store.handleDelete(NOTE);

  const pruned = await store.prune((path) => path === NOTE);

  assert.deepEqual(pruned, [], 'it is not a deleted note, whatever the file says');
  assert.deepEqual(await store.load(NOTE), [check()]);
});

test('a prune repairs the stale flag rather than leaving it to fire later', async () => {
  const { store } = setup();
  await store.save(NOTE, [check()]);
  await store.handleDelete(NOTE);

  await store.prune((path) => path === NOTE);
  // Now the note really is gone. The first prune must have cleared the flag,
  // or this one would report a deletion that already happened.
  assert.deepEqual(await store.prune(allGone), []);
  assert.deepEqual(await store.load(NOTE), [check()]);
});

test('a note reappearing clears the flag straight away', async () => {
  const { store } = setup();
  await store.save(NOTE, [check()]);
  await store.handleDelete(NOTE);

  await store.handleCreate(NOTE);

  assert.deepEqual(await store.prune(allGone), [], 'the checks are no longer a deleted note\'s');
  assert.deepEqual(await store.load(NOTE), [check()]);
});

test('a note appearing where nothing was recorded is not an event', async () => {
  const { adapter, store } = setup();
  await store.handleCreate('notes/brand-new.md');
  assert.equal(adapter.files.size, 0);
});

test('queued saves collapse into one write', async () => {
  const { adapter, store } = setup();
  store.queue(NOTE, [check()]);
  store.queue(NOTE, [check(), check({ id: 'c2' })]);
  store.queue(NOTE, [check(), check({ id: 'c2' }), check({ id: 'c3' })]);
  await store.flush();

  assert.equal(adapter.writes, 1);
  assert.equal((await store.load(NOTE)).length, 3);
});

test('a flush with nothing queued writes nothing', async () => {
  const { adapter, store } = setup();
  await store.flush();
  assert.equal(adapter.writes, 0);
});
