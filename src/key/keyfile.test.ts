/* The key file.
 *
 * The thing worth asserting is not that a string round-trips — it is that the
 * key never lands in the vault, that a device with nowhere to put it says so
 * instead of half-working, and that the file is written 0600.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KeyFile, cleanKey, keyFilePath, type KeyFileSystem } from './keyfile';

function fakeFs(): KeyFileSystem & { files: Map<string, string>; modes: Map<string, number>; dirs: string[] } {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const dirs: string[] = [];
  return {
    files,
    modes,
    dirs,
    read: (path) => files.get(path) ?? null,
    write: (path, data) => {
      files.set(path, data);
      modes.set(path, 0o600);
    },
    remove: (path) => void files.delete(path),
    mkdirp: (path) => void dirs.push(path),
  };
}

const POSIX = { home: '/Users/ada', platform: 'darwin' };

test('the key lives outside the vault, at one fixed path', () => {
  assert.equal(keyFilePath(POSIX), '/Users/ada/.config/recall/key');
  assert.equal(keyFilePath({ home: '/home/ada', platform: 'linux' }), '/home/ada/.config/recall/key');
});

test('Windows gets its own equivalent rather than a unix path', () => {
  assert.equal(
    keyFilePath({ home: 'C:\\Users\\Ada', platform: 'win32', appData: 'C:\\Users\\Ada\\AppData\\Roaming' }),
    'C:\\Users\\Ada\\AppData\\Roaming\\recall\\key',
  );
});

test('Windows without APPDATA set still lands somewhere sane', () => {
  assert.equal(
    keyFilePath({ home: 'C:\\Users\\Ada', platform: 'win32' }),
    'C:\\Users\\Ada\\AppData\\Roaming\\recall\\key',
  );
});

test('a key survives a round trip', () => {
  const fs = fakeFs();
  const file = new KeyFile(fs, keyFilePath(POSIX));

  file.write('sk-ant-example');

  assert.equal(file.read(), 'sk-ant-example');
});

test('the file is written owner-only, and its directory made first', () => {
  const fs = fakeFs();
  const file = new KeyFile(fs, keyFilePath(POSIX));

  file.write('sk-ant-example');

  assert.equal(fs.modes.get('/Users/ada/.config/recall/key'), 0o600);
  assert.deepEqual(fs.dirs, ['/Users/ada/.config/recall']);
});

test('nothing about the key is written under the vault', () => {
  const fs = fakeFs();
  const file = new KeyFile(fs, keyFilePath(POSIX));

  file.write('sk-ant-example');

  for (const path of fs.files.keys()) {
    assert.equal(path.includes('.obsidian'), false, `${path} is inside the vault`);
  }
});

test('the whitespace a paste picks up is not a different key', () => {
  const fs = fakeFs();
  const file = new KeyFile(fs, keyFilePath(POSIX));

  file.write('  sk-ant-example\n');

  assert.equal(file.read(), 'sk-ant-example');
  assert.equal(cleanKey('sk-ant\n-example  '), 'sk-ant-example');
});

test('no key file reads as not connected, not as an empty key', () => {
  const file = new KeyFile(fakeFs(), keyFilePath(POSIX));
  assert.equal(file.read(), null);
});

test('a file holding only whitespace is not a key', () => {
  const fs = fakeFs();
  fs.files.set(keyFilePath(POSIX), '\n  \n');

  assert.equal(new KeyFile(fs, keyFilePath(POSIX)).read(), null);
});

test('a key file that throws reads as not connected rather than crashing', () => {
  const fs = fakeFs();
  fs.read = () => {
    throw new Error('EACCES');
  };

  assert.equal(new KeyFile(fs, keyFilePath(POSIX)).read(), null);
});

test('clearing removes the file', () => {
  const fs = fakeFs();
  const file = new KeyFile(fs, keyFilePath(POSIX));
  file.write('sk-ant-example');

  file.clear();

  assert.equal(file.read(), null);
  assert.equal(fs.files.size, 0);
});

test('a device with nowhere to write says so rather than half-working', () => {
  // A phone: no filesystem outside the vault, so there is no key and asking
  // for a check is unavailable. That falls out of the architecture.
  const file = new KeyFile(null, '');

  assert.equal(file.available, false);
  assert.equal(file.read(), null);
  assert.throws(() => file.write('sk-ant-example'), /nowhere outside the vault/);
});

test('clearing a key that was never available is not an error', () => {
  assert.doesNotThrow(() => new KeyFile(null, '').clear());
});

test('an empty paste is refused rather than stored', () => {
  const fs = fakeFs();
  const file = new KeyFile(fs, keyFilePath(POSIX));

  assert.throws(() => file.write('   '), /not a key/);
  assert.equal(fs.files.size, 0);
});
