/* What a card says when the answer is not an assessment.
 *
 * Two of the three outcomes of asking for a check are not verdicts, and both
 * of them are the same shape as one: a card with a body and no label. Keeping
 * them here — pure, and away from the transport — is what lets the leaf render
 * one thing regardless of how the check went.
 *
 * The rule both of them observe, ported from the desktop app: a check that did
 * not happen leaves the verdict null. Labelling the writing when nothing read
 * it would be a lie about what happened, and the highlight stays neutral grey
 * to say exactly that.
 */
import { CheckerError, type Verdict } from '../checker/protocol';

export interface Outcome {
  verdict: Verdict | null;
  body: string;
}

/** Trims to a length that fits a card without wrapping past a line or two. */
export function trim(text: string, max: number): string {
  const clean = (text ?? '').trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Why a card carries placeholder text instead of an assessment. The two
 *  read differently because they are different: one is a thing to fix, the
 *  other is a choice the reader made. */
export type DemoReason = 'no-key' | 'chosen';

/** Nothing read the span. Says so in the card rather than leaving an empty
 *  one, and — where there is something to do about it — says what. */
export function demoOutcome(quote: string, reason: DemoReason = 'no-key'): Outcome {
  const span = `"${trim(quote, 60)}"`;
  return {
    verdict: null,
    body:
      reason === 'chosen'
        ? `Demo mode is on, so this is placeholder text rather than a real assessment of ${span}. ` +
          `Your highlight is saved. Turn demo mode off in Recall's settings to have this span read.`
        : `No checker is connected, so this is placeholder text rather than a real assessment of ${span}. ` +
          `Add an API key in Recall's settings to get an actual reading of this span.`,
  };
}

/** The check was asked for and did not come back.
 *
 *  A key that is missing or rejected is not really a failure of this span, so
 *  it reads as demo mode — the same card the user would have got before they
 *  tried. Everything else says what went wrong and that the highlight is safe,
 *  because the span is still marked and still retryable. */
export function failureOutcome(error: unknown, quote: string): Outcome {
  if (error instanceof CheckerError && error.code === 'not_connected') {
    return demoOutcome(quote);
  }
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'The check could not be completed.';
  return { verdict: null, body: `${message} Your highlight is saved — try again.` };
}

/** What a question's card says when the reply is not an answer. */
export interface Reply {
  body: string;
  /** True when `body` is a placeholder or an error, which keeps it out of the
   *  conversation the next question is asked with. */
  failed: boolean;
}

/** Nothing read the question. Same two reasons as a check, same two voices. */
export function demoReply(reason: DemoReason = 'no-key'): Reply {
  return {
    failed: true,
    body:
      reason === 'chosen'
        ? 'Demo mode is on, so this is placeholder text rather than an answer. ' +
          "Your question is saved. Turn demo mode off in Recall's settings and try again to have it answered."
        : 'No checker is connected, so this is placeholder text rather than an answer. ' +
          "Your question is saved. Add an API key in Recall's settings and try again to have it answered.",
  };
}

/** The question was asked and no answer came back. */
export function failureReply(error: unknown): Reply {
  if (error instanceof CheckerError && error.code === 'not_connected') return demoReply();
  const message =
    error instanceof Error && error.message ? error.message : 'The question could not be answered.';
  return { failed: true, body: `${message} Your question is saved — try again.` };
}

/** What Claude reads as "the page".
 *
 *  Frontmatter is metadata rather than writing, so it is stripped: it is not
 *  something the user is being tested on, and it would sit in the cached
 *  prefix of every check on the note. The prompt is pulled out of it first by
 *  the caller, which is the one thing in there worth having.
 *
 *  `frontmatterEnd` is the offset the metadata cache reports, or 0 when the
 *  note has none. */
export function pageText(doc: string, frontmatterEnd = 0): string {
  return doc.slice(Math.max(0, Math.min(frontmatterEnd, doc.length))).trim();
}

/** Whether a span sits inside the note's frontmatter, which is not writing to
 *  be checked. */
export function inFrontmatter(from: number, frontmatterEnd: number): boolean {
  return frontmatterEnd > 0 && from < frontmatterEnd;
}
