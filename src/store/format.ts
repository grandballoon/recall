/* What a note's checks look like on disk, and how to read them back safely.
 *
 * One file per note rather than one file for the vault: `saveData` rewrites
 * the whole of `data.json`, which is the wrong shape for something that
 * changes on every edit. A write touches one note, a bad file costs one
 * note's checks, and loading is lazy.
 *
 * The rule the desktop app arrived at the hard way is kept: a file that
 * cannot be read is never written over. `parseNoteFile` says *why* it failed
 * so the caller can tell "nothing saved yet" from "something is wrong here",
 * because seeding over the second one is silent and total.
 */
import type { Verdict } from '../checker/protocol';

export const FORMAT_VERSION = 1;

export interface StoredCheck {
  id: string;
  /** Offsets into the note as it was when this was last written. CM6 keeps
   *  them current while the note is open; `quote` puts the check back when
   *  it was not. */
  from: number;
  to: number;
  quote: string;
  /** Null when no assessment exists — in flight, failed, or demo mode. */
  verdict: Verdict | null;
  body: string;
  /** Set when this check hangs off another check rather than off the note. */
  parentId: string | null;
  /** True once an edit deleted the span. The check survives the decoration;
   *  it is re-anchored from its quote, or listed in the leaf if it cannot be. */
  unanchored?: boolean;
  /** What the reader asked, when they put a question instead of asking for a
   *  verdict. `body` is then Claude's answer and `verdict` stays null: a
   *  question is not an assessment, so it never colours the prose. */
  question?: string;
  /** Set on a question whose `body` is a placeholder or an error rather than
   *  an answer. A check says the same thing with a null verdict; a question
   *  has no verdict to say it with. */
  failed?: boolean;
  /** Set when the reader has dealt with this check. The record and its note
   *  stay; the highlight comes off the prose, because the span is no longer
   *  something they want marked. Dismissing deletes instead. */
  resolved?: boolean;
}

/** Whether this is about a particular span — of the note, or of the card it
 *  hangs off. A question need not be: one put to the whole note, or a
 *  follow-up in a thread, has nothing to point at, and is stored with an empty
 *  range rather than a second shape. */
export function hasSpan(check: StoredCheck): boolean {
  return check.from < check.to;
}

export function isQuestion(check: StoredCheck): boolean {
  return check.question !== undefined;
}

/** A question with no span, asked of another card: the next line of the
 *  conversation under it, rather than a branch off some part of it. */
export function isFollowUp(check: StoredCheck): boolean {
  return check.parentId !== null && isQuestion(check) && !hasSpan(check);
}

/** Whether `body` is something Claude actually said about this. Placeholders
 *  and error messages are not, and must never be replayed to it as its own
 *  words. */
export function isAnswered(check: StoredCheck): boolean {
  if (check.body === '') return false;
  return isQuestion(check) ? check.failed !== true : check.verdict !== null;
}

export interface NoteFile {
  v: number;
  /** The note these checks belong to. Carried in the file so a filename
   *  collision is detectable rather than silently serving another note's
   *  checks. */
  path: string;
  /** Set when the note itself was deleted. A delete is reversible through
   *  the trash; deleting the assessments with it is not. */
  deleted?: boolean;
  checks: StoredCheck[];
}

export type ReadResult =
  | { kind: 'ok'; file: NoteFile }
  /** Nothing saved yet — the only failure that may lead to writing. */
  | { kind: 'empty' }
  | { kind: 'unreadable'; why: string };

/** FNV-1a, 64-bit. A note's path decides its filename with no index to keep
 *  in step, and 64 bits makes a collision in a vault-sized set of paths a
 *  non-event — which the `path` check inside the file catches anyway. */
export function fileNameFor(notePath: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const ch of notePath) {
    hash = (hash ^ BigInt(ch.codePointAt(0)!)) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return `${hash.toString(16).padStart(16, '0')}.json`;
}

export function serialiseNoteFile(file: NoteFile): string {
  return JSON.stringify(file);
}

function isCheck(value: unknown): value is StoredCheck {
  const c = value as StoredCheck;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    typeof c.from === 'number' &&
    typeof c.to === 'number' &&
    typeof c.quote === 'string' &&
    typeof c.body === 'string' &&
    (c.question === undefined || typeof c.question === 'string')
  );
}

/** Reports why a read failed rather than returning a bare nothing.
 *
 *  `expectedPath` is checked against the file's own: two notes hashing to one
 *  filename would otherwise hand a note somebody else's checks. */
export function parseNoteFile(raw: string | null, expectedPath: string): ReadResult {
  if (raw === null || raw.trim() === '') return { kind: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'unreadable', why: `it is not valid JSON (${(e as Error).message})` };
  }

  const file = parsed as Partial<NoteFile>;
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return { kind: 'unreadable', why: 'it is not shaped like a Recall file' };
  }
  if (file.v !== FORMAT_VERSION) {
    return { kind: 'unreadable', why: `it is format version ${String(file.v)}, and this build reads ${FORMAT_VERSION}` };
  }
  if (typeof file.path !== 'string') {
    return { kind: 'unreadable', why: 'it does not say which note it belongs to' };
  }
  if (file.path !== expectedPath) {
    return { kind: 'unreadable', why: `it belongs to ${file.path}, not ${expectedPath}` };
  }
  if (!Array.isArray(file.checks) || !file.checks.every(isCheck)) {
    return { kind: 'unreadable', why: 'its checks are not shaped like checks' };
  }

  return {
    kind: 'ok',
    file: {
      v: FORMAT_VERSION,
      path: file.path,
      ...(file.deleted ? { deleted: true } : {}),
      checks: file.checks,
    },
  };
}
