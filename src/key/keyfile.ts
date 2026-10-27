/* Where the API key lives, and why it is not in the vault.
 *
 * The desktop app's hard constraint — the key in the OS keychain, never in the
 * webview — cannot hold here. A plugin *is* the renderer, so the key is in the
 * webview whatever we do, and Obsidian has no secret store to borrow instead.
 *
 * What is still ours to protect is the vault. Anything under it rides Obsidian
 * Sync to every device in plaintext and sits in whatever backup the reader
 * keeps, which is a worse exposure than the one we are forced into. So the key
 * goes to one file outside the vault, written 0600, and nothing about it ever
 * touches `data.json`.
 *
 * One fixed path rather than a configurable one is deliberate: a plugin that
 * reads and writes outside the vault has to justify itself at review, and
 * "one file, this path, the key you pasted" is a story that survives that
 * conversation where an arbitrary user-supplied path does not.
 *
 * The filesystem is injected, so the path logic and the read/write rules are
 * tested without going near a real disk or a real Obsidian.
 */

/** The slice of `node:fs` this needs, which is also all a test has to fake. */
export interface KeyFileSystem {
  read(path: string): string | null;
  /** Writes the file such that only the owner can read it. */
  write(path: string, data: string): void;
  remove(path: string): void;
  mkdirp(path: string): void;
}

export interface KeyLocation {
  home: string;
  platform: string;
  /** `%APPDATA%` on Windows, where a config file belongs instead of `~`. */
  appData?: string | undefined;
}

const DIR_NAME = 'recall';
const FILE_NAME = 'key';

/** The one fixed path. `~/.config/recall/key`, or the platform's equivalent. */
export function keyFilePath(where: KeyLocation): string {
  if (where.platform === 'win32') {
    const base = where.appData || `${where.home}\\AppData\\Roaming`;
    return `${base}\\${DIR_NAME}\\${FILE_NAME}`;
  }
  // macOS included: Obsidian is a config file's worth of state here, not a
  // document, and `~/.config` is where a reader can find and delete it.
  return `${where.home}/.config/${DIR_NAME}/${FILE_NAME}`;
}

function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? path : path.slice(0, cut);
}

/** An API key is one line of ASCII. Anything else in that file is a mistake —
 *  a stray newline from an editor, a copied trailing space — and is not worth
 *  failing over. */
export function cleanKey(raw: string): string {
  return raw.replace(/\s+/g, '').trim();
}

export class KeyFile {
  constructor(
    private readonly fs: KeyFileSystem | null,
    private readonly path: string,
  ) {}

  /** False on mobile, where there is no filesystem outside the vault to read.
   *  The consequence is designed for rather than papered over: a phone can
   *  read existing checks and cannot ask for new ones. */
  get available(): boolean {
    return this.fs !== null;
  }

  /** Where the key is kept, for settings to show. The path is not a secret;
   *  the file is. */
  get location(): string {
    return this.path;
  }

  read(): string | null {
    if (!this.fs) return null;
    try {
      const raw = this.fs.read(this.path);
      if (raw === null) return null;
      const key = cleanKey(raw);
      return key === '' ? null : key;
    } catch {
      // An unreadable key file is the same to us as no key: the reader is
      // told they are not connected, which is true, and settings offers the
      // paste box that fixes it.
      return null;
    }
  }

  write(key: string): void {
    if (!this.fs) throw new Error('There is nowhere outside the vault to write a key on this device.');
    const clean = cleanKey(key);
    if (clean === '') throw new Error('That is not a key.');
    this.fs.mkdirp(parentOf(this.path));
    this.fs.write(this.path, `${clean}\n`);
  }

  clear(): void {
    if (!this.fs) return;
    try {
      this.fs.remove(this.path);
    } catch {
      // Already gone is the outcome we wanted.
    }
  }
}

/** The real filesystem, or null where there is not one.
 *
 *  `require` rather than an import: these are Node builtins that exist in
 *  Obsidian's desktop runtime and not on mobile, and a static import would
 *  make the whole bundle fail to load on a phone.
 */
export function nodeKeyFileSystem(): KeyFileSystem | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    return {
      read(path) {
        return fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
      },
      write(path, data) {
        // Owner read/write only. The mode is also reapplied on an existing
        // file, because `writeFileSync` leaves the original permissions alone.
        fs.writeFileSync(path, data, { mode: 0o600 });
        fs.chmodSync(path, 0o600);
      },
      remove(path) {
        if (fs.existsSync(path)) fs.unlinkSync(path);
      },
      mkdirp(path) {
        fs.mkdirSync(path, { recursive: true, mode: 0o700 });
      },
    };
  } catch {
    return null;
  }
}

/** The key file for this device, or one that reports itself unavailable. */
export function openKeyFile(): KeyFile {
  const fs = nodeKeyFileSystem();
  if (!fs) return new KeyFile(null, '');

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os') as typeof import('os');
    return new KeyFile(
      fs,
      keyFilePath({
        home: os.homedir(),
        platform: process.platform,
        appData: process.env['APPDATA'],
      }),
    );
  } catch {
    return new KeyFile(null, '');
  }
}
