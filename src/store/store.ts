/* The checks for every note in the vault, one file at a time.
 *
 * The adapter is injected rather than imported, so everything here runs in a
 * test with a map for a disk — the Obsidian `DataAdapter` satisfies this
 * interface as it stands, and `main.ts` is the only place that knows that.
 */
import { fileNameFor, parseNoteFile, serialiseNoteFile, FORMAT_VERSION } from './format';
import type { NoteFile, StoredCheck } from './format';

/** The slice of Obsidian's `DataAdapter` this needs. */
export interface StoreAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface Unreadable {
  path: string;
  why: string;
}

const SAVE_DELAY_MS = 1200;

export class CheckStore {
  /** Notes whose file could not be read this session. Persistence is off for
   *  each of them — the desktop app's safe mode, scoped to one note instead
   *  of the whole library. */
  private readonly unreadable = new Map<string, string>();
  private readonly pending = new Map<string, StoredCheck[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly adapter: StoreAdapter,
    private readonly folder: string,
    private readonly delayMs: number = SAVE_DELAY_MS,
  ) {}

  private fileFor(notePath: string): string {
    return `${this.folder}/${fileNameFor(notePath)}`;
  }

  private async readFile(notePath: string): Promise<NoteFile | null> {
    const file = this.fileFor(notePath);
    let raw: string | null = null;
    if (await this.adapter.exists(file)) {
      try {
        raw = await this.adapter.read(file);
      } catch (e) {
        this.unreadable.set(notePath, `it could not be read (${(e as Error).message})`);
        return null;
      }
    }

    const result = parseNoteFile(raw, notePath);
    if (result.kind === 'unreadable') {
      this.unreadable.set(notePath, result.why);
      return null;
    }
    this.unreadable.delete(notePath);
    return result.kind === 'ok' ? result.file : { v: FORMAT_VERSION, path: notePath, checks: [] };
  }

  /** The checks for a note, or none. A note whose file is unreadable reads as
   *  no checks and refuses to be written — never as a fresh start. */
  async load(notePath: string): Promise<StoredCheck[]> {
    const file = await this.readFile(notePath);
    return file?.checks ?? [];
  }

  isUnreadable(notePath: string): boolean {
    return this.unreadable.has(notePath);
  }

  /** Why a note's checks could not be read, or null if they could. The leaf
   *  reports this verbatim: "nothing saved yet" and "something is wrong here"
   *  need to look different to the reader, not just to us. */
  whyUnreadable(notePath: string): string | null {
    return this.unreadable.get(notePath) ?? null;
  }

  listUnreadable(): Unreadable[] {
    return [...this.unreadable].map(([path, why]) => ({ path, why }));
  }

  /** Writes now. Refuses on a note we failed to read, because carrying on
   *  with an empty set would save that emptiness over whatever is there. */
  async save(notePath: string, checks: StoredCheck[]): Promise<void> {
    const existing = await this.readFile(notePath);
    if (existing === null) return;

    const file = this.fileFor(notePath);
    if (checks.length === 0 && !existing.deleted) {
      if (await this.adapter.exists(file)) await this.adapter.remove(file);
      return;
    }

    await this.adapter.mkdir(this.folder);
    await this.adapter.write(
      file,
      serialiseNoteFile({
        v: FORMAT_VERSION,
        path: notePath,
        ...(existing.deleted ? { deleted: true } : {}),
        checks,
      }),
    );
  }

  /** Debounced, as on the other surfaces: a write per keystroke is a write
   *  per keystroke however small the file is. */
  queue(notePath: string, checks: StoredCheck[]): void {
    this.pending.set(notePath, checks);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const queued = [...this.pending];
    this.pending.clear();
    for (const [notePath, checks] of queued) await this.save(notePath, checks);
  }

  /** A note moved. The filename is a function of the path, so the file moves
   *  with it and says where it now belongs.
   *
   *  A file we cannot parse still moves — as the bytes we found, untouched.
   *  Leaving it behind would strand it under a path no note has any more,
   *  and rewriting it would be exactly the overwrite this store refuses. */
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const from = this.fileFor(oldPath);
    if (!(await this.adapter.exists(from))) return;

    let raw: string;
    try {
      raw = await this.adapter.read(from);
    } catch (e) {
      this.unreadable.set(oldPath, `it could not be read (${(e as Error).message})`);
      return;
    }

    const parsed = parseNoteFile(raw, oldPath);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'ok' && parsed.file.checks.length === 0 && !parsed.file.deleted) return;

    const body =
      parsed.kind === 'ok' ? serialiseNoteFile({ ...parsed.file, path: newPath }) : raw;

    await this.adapter.mkdir(this.folder);
    await this.adapter.write(this.fileFor(newPath), body);
    await this.adapter.remove(from);

    const why = this.unreadable.get(oldPath);
    if (why !== undefined) {
      this.unreadable.delete(oldPath);
      this.unreadable.set(newPath, why);
    }
  }

  /** A note was deleted. Its checks are kept and marked, because the delete
   *  is reversible through the trash and the assessments are not. */
  async handleDelete(notePath: string): Promise<void> {
    const file = await this.readFile(notePath);
    if (file === null || file.checks.length === 0) return;

    await this.adapter.mkdir(this.folder);
    await this.adapter.write(
      this.fileFor(notePath),
      serialiseNoteFile({ ...file, deleted: true }),
    );
  }

  /** The command behind "prune checks for deleted notes". Only files that say
   *  their note is gone, and only on being asked.
   *
   *  `isLive` says whether a note exists at that path right now. A delete is
   *  reversible through the trash, so the flag alone is not evidence: a note
   *  that came back wears a stale one, and pruning on the flag by itself
   *  would destroy the checks of a note sitting right there. Those are
   *  repaired instead, which is also what makes this safe to run at any time. */
  async prune(isLive: (notePath: string) => boolean): Promise<string[]> {
    if (!(await this.adapter.exists(this.folder))) return [];

    const pruned: string[] = [];
    const { files } = await this.adapter.list(this.folder);
    for (const file of files) {
      let raw: string;
      try {
        raw = await this.adapter.read(file);
      } catch {
        continue; // Unreadable stays put; we do not delete what we cannot read.
      }
      let parsed: NoteFile;
      try {
        parsed = JSON.parse(raw) as NoteFile;
      } catch {
        continue;
      }
      if (parsed?.deleted !== true || typeof parsed.path !== 'string') continue;

      if (isLive(parsed.path)) {
        // The note is back. Clear the flag rather than acting on it.
        const { deleted: _gone, ...revived } = parsed;
        await this.adapter.write(file, serialiseNoteFile(revived as NoteFile));
        continue;
      }
      await this.adapter.remove(file);
      pruned.push(parsed.path);
    }
    return pruned;
  }

  /** A note appeared at a path whose checks we had marked deleted — it was
   *  restored from the trash, or rewritten by a sync.
   *
   *  The flag is cleared as soon as we hear about it, so the checks are not
   *  living on borrowed time until someone happens to run a prune. */
  async handleCreate(notePath: string): Promise<void> {
    const file = await this.readFile(notePath);
    if (file === null || file.deleted !== true) return;

    const { deleted: _gone, ...revived } = file;
    await this.adapter.mkdir(this.folder);
    await this.adapter.write(this.fileFor(notePath), serialiseNoteFile(revived));
  }
}
