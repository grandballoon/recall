/* Turning a thread into the conversation Claude is asked to continue.
 *
 * What is stored is a tree: every card hangs off the note or off another card,
 * and a card is either a check or a question. What a question needs sent with
 * it is a line through that tree — everything said on the way down to it, in
 * the order it was said — so that "why?" under an assessment means "why did
 * you say that", and a second follow-up can lean on the first.
 *
 * The line is the card's ancestors, root first. Wherever a step on that line
 * is a follow-up, the follow-ups asked before it under the same card come
 * first, because that is the conversation it was a reply in. A question about
 * a span is a branch rather than a reply, so it brings only its ancestors.
 *
 * Nothing here imports `obsidian`, or knows how a request is sent.
 */
import type { Turn } from '../checker/protocol';
import { hasSpan, isAnswered, isFollowUp, isQuestion, type StoredCheck } from '../store/format';

/** The cards a question is asked in the light of, oldest first, ending with
 *  the question itself. Empty if the id is not in the note. */
export function lineOf(byId: ReadonlyMap<string, StoredCheck>, id: string): StoredCheck[] {
  const ancestors: StoredCheck[] = [];
  // Guarded against a cycle a hand-edited file could introduce, as the leaf's
  // own walk up the same chain is.
  const seen = new Set<string>();
  for (let at = byId.get(id); at && !seen.has(at.id); ) {
    seen.add(at.id);
    ancestors.unshift(at);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }

  const line: StoredCheck[] = [];
  for (const step of ancestors) {
    if (isFollowUp(step)) {
      // A map iterates in insertion order, which is the order they were asked.
      for (const earlier of byId.values()) {
        if (earlier.id === step.id) break;
        if (earlier.parentId === step.parentId && isFollowUp(earlier)) line.push(earlier);
      }
    }
    line.push(step);
  }
  return line;
}

/** What the reader's side of one card reads as. A span is quoted in full and
 *  said to be either theirs or Claude's, because a span of an answer and a
 *  span of the note are different things to be asked about. */
function asked(check: StoredCheck): string {
  if (!hasSpan(check)) return check.question ?? '';

  const source = check.parentId === null ? 'my explanation' : 'your reply';
  const span = `<span>\n${check.quote}\n</span>`;
  return isQuestion(check)
    ? `About this span of ${source}:\n\n${span}\n\n${check.question}`
    : `I highlighted this span of ${source} and asked you to check it:\n\n${span}`;
}

function replied(check: StoredCheck): string {
  return isQuestion(check) ? check.body : `Verdict: ${check.verdict}.\n\n${check.body}`;
}

/** The conversation to send for one question: every earlier card on its line
 *  that got a real answer, as an exchange, and then the question.
 *
 *  A card whose body is a placeholder or an error is left out whole. Sending
 *  it would put words in Claude's mouth it never said, and sending only the
 *  asking half would leave a question hanging that nobody is waiting on. */
export function conversationFor(byId: ReadonlyMap<string, StoredCheck>, id: string): Turn[] {
  const line = lineOf(byId, id);
  const last = line.pop();
  if (!last) return [];

  const turns: Turn[] = [];
  for (const check of line) {
    if (!isAnswered(check)) continue;
    turns.push({ role: 'user', text: asked(check) }, { role: 'assistant', text: replied(check) });
  }
  turns.push({ role: 'user', text: asked(last) });
  return turns;
}
