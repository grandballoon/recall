/* Turning a card's note into paragraphs and highlight segments.
 *
 * A question asked about a card anchors to offsets into the stored `body`
 * string, exactly as a check on the note anchors into the document. So the
 * text has to reach the DOM with those offsets still meaning something: every
 * paragraph knows where it starts in the original string, and a selection is
 * read back as `paragraph.start + offsetWithinParagraph`.
 *
 * That is also why the body is never run through `MarkdownRenderer`. Rendering
 * the markdown would drop the syntax characters these offsets are counted in
 * and put every nested highlight on the wrong words.
 */
import type { Verdict } from '../checker/protocol';

export interface Paragraph {
  text: string;
  /** Where this paragraph's first character sits in the body string. */
  start: number;
}

export interface Mark {
  id: string;
  from: number;
  to: number;
  verdict: Verdict | null;
}

export interface Segment {
  text: string;
  /** The check this run of text belongs to, or null for plain prose. */
  checkId: string | null;
  verdict: Verdict | null;
}

/** Splits on blank lines, keeping each paragraph's offset into the original.
 *
 *  A single newline is not a paragraph break, which is how the assessments
 *  actually arrive; two or more is. Empty paragraphs are dropped, because a
 *  run of blank lines is spacing rather than content. */
export function paragraphsOf(body: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const breaks = /\n{2,}/g;
  let at = 0;
  let match: RegExpExecArray | null;

  const push = (text: string, start: number): void => {
    if (text.trim() !== '') paragraphs.push({ text, start });
  };

  while ((match = breaks.exec(body)) !== null) {
    push(body.slice(at, match.index), at);
    at = match.index + match[0].length;
  }
  push(body.slice(at), at);
  return paragraphs;
}

/** Cuts one paragraph into plain and highlighted runs.
 *
 *  Marks that overlap an earlier one are skipped rather than nested: a span
 *  inside a span has no meaning here, and splitting them would put the same
 *  text under two checks. */
export function segmentsFor(paragraph: Paragraph, marks: readonly Mark[]): Segment[] {
  const end = paragraph.start + paragraph.text.length;

  const clipped = marks
    .map((mark) => ({
      ...mark,
      from: Math.max(mark.from, paragraph.start),
      to: Math.min(mark.to, end),
    }))
    .filter((mark) => mark.from < mark.to)
    .sort((a, b) => a.from - b.from);

  const segments: Segment[] = [];
  let at = paragraph.start;

  for (const mark of clipped) {
    if (mark.from < at) continue; // Overlaps one already taken.
    if (mark.from > at) {
      segments.push({
        text: paragraph.text.slice(at - paragraph.start, mark.from - paragraph.start),
        checkId: null,
        verdict: null,
      });
    }
    segments.push({
      text: paragraph.text.slice(mark.from - paragraph.start, mark.to - paragraph.start),
      checkId: mark.id,
      verdict: mark.verdict,
    });
    at = mark.to;
  }

  if (at < end) {
    segments.push({
      text: paragraph.text.slice(at - paragraph.start),
      checkId: null,
      verdict: null,
    });
  }
  return segments;
}

/** Where a selection inside a rendered body sits in the body string.
 *
 *  Every segment is rendered as its own element holding exactly one text node,
 *  so an offset within that text node is an offset from the element's own
 *  start. `startOf` resolves a node to the recorded start of the run holding
 *  it; the caller supplies it because only the renderer knows which element is
 *  which. Returns null when the selection is not inside a rendered body, which
 *  is every selection made anywhere else in the leaf. */
export function offsetsFromSelection(
  selection: { anchorNode: Node | null; anchorOffset: number; focusNode: Node | null; focusOffset: number },
  startOf: (node: Node | null) => number | null,
): { from: number; to: number } | null {
  const anchor = startOf(selection.anchorNode);
  const focus = startOf(selection.focusNode);
  if (anchor === null || focus === null) return null;

  const a = anchor + selection.anchorOffset;
  const b = focus + selection.focusOffset;
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  return from < to ? { from, to } : null;
}
