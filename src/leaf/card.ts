/* One check or one question, as a card in the leaf.
 *
 * Built with `createEl` rather than `innerHTML`: the community review
 * guidelines prohibit the latter outright, and none of this needs it.
 *
 * The note is rendered as runs of plain text rather than through
 * `MarkdownRenderer`, and that is a decision rather than a shortcut — see
 * `body.ts`, which does the arithmetic. A question asked about a card anchors
 * to offsets into the stored body string, so the text has to reach the DOM
 * with those offsets intact; markdown rendering would drop the syntax
 * characters they are counted in and put every nested highlight on the wrong
 * words. Assessments are one to three sentences of prose, so there is little
 * to lose and a whole class of defect to avoid.
 */
import { hasSpan, isQuestion, type StoredCheck } from '../store/format';
import type { Verdict } from '../checker/protocol';
import { trim } from '../check/outcome';
import { paragraphsOf, segmentsFor, type Mark } from './body';

/** The attribute a rendered run carries so a selection can be read back. */
export const OFFSET_ATTR = 'data-recall-offset';

/** The reader's words for each verdict. `missing` is deliberately not a
 *  failure: an incomplete answer is not a wrong one. */
const VERDICT_LABELS: Record<Verdict, string> = {
  wrong: 'Incorrect',
  imprecise: 'Imprecise',
  missing: 'Incomplete',
  solid: 'Solid',
};

export interface CardActions {
  /** Clicking the card — scrolls to the span and selects it. Absent when
   *  there is nothing to reveal, which is what makes the card inert. */
  onOpen?: (() => void) | undefined;
  /** Switches an editor to source mode and then reveals. Offered only when the
   *  note is not being edited, because changing a view mode is the reader's
   *  call to make and not a side effect of clicking a card. */
  onReveal?: (() => void) | undefined;
  onResolve?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  /** Opening a question that was asked about this card. */
  onOpenChild?: ((id: string) => void) | undefined;
}

export interface CardOptions {
  running?: boolean;
  /** Questions asked about this card's note, for the highlights inside it. */
  children?: readonly StoredCheck[];
  /** True when this card is the one being questioned, which is what earns it
   *  the hint about how to do that. */
  questionable?: boolean;
  /** How many follow-ups sit under this card, for a card shown outside its
   *  own thread — where they are otherwise invisible. */
  replies?: number;
}

/** A check that was asked for but never answered — the plugin was unloaded,
 *  or Obsidian closed, while it was in flight. It has no verdict and no body,
 *  which no completed outcome ever produces: a demo card and a failed card
 *  both write a body. */
export function isUnfinished(check: StoredCheck): boolean {
  return check.verdict === null && check.body === '';
}

function marksFrom(children: readonly StoredCheck[]): Mark[] {
  return children
    .filter((child) => hasSpan(child) && !child.resolved && !child.unanchored)
    .map((child) => ({
      id: child.id,
      from: child.from,
      to: child.to,
      verdict: child.verdict,
    }));
}

/** The note, as runs of text that still know where they came from.
 *
 *  Every run is its own element holding exactly one text node, so an offset
 *  inside that text node is an offset from the run's recorded start — which is
 *  what lets a selection here become a check anchored to the body string. */
function renderBody(
  parent: HTMLElement,
  check: StoredCheck,
  children: readonly StoredCheck[],
  onOpenChild: ((id: string) => void) | undefined,
): void {
  const el = parent.createDiv({ cls: `recall-card-body${check.failed ? ' is-failed' : ''}` });
  const marks = marksFrom(children);

  for (const paragraph of paragraphsOf(check.body)) {
    const p = el.createEl('p');
    let at = paragraph.start;

    for (const segment of segmentsFor(paragraph, marks)) {
      const run = p.createSpan({
        cls: segment.checkId
          ? `recall-nested ${segment.verdict ? `recall-${segment.verdict}` : 'recall-unassessed'}`
          : 'recall-run',
        text: segment.text,
      });
      run.setAttribute(OFFSET_ATTR, String(at));
      if (segment.checkId && onOpenChild) {
        const id = segment.checkId;
        run.addClass('is-openable');
        run.addEventListener('click', (event) => {
          event.stopPropagation();
          onOpenChild(id);
        });
      }
      at += segment.text.length;
    }
  }
}

function renderTools(parent: HTMLElement, actions: CardActions): void {
  const tools = parent.createDiv({ cls: 'recall-card-tools' });
  let any = false;

  const add = (label: string, cls: string, run: () => void): void => {
    any = true;
    const button = tools.createEl('button', { cls: `recall-btn ${cls}`, text: label });
    button.addEventListener('click', (event) => {
      // The card itself opens on click; a tool is not an open.
      event.stopPropagation();
      run();
    });
  };

  if (actions.onRetry) add('Try again', 'is-ghost', actions.onRetry);
  if (actions.onReveal) add('Reveal in editor', 'is-ghost', actions.onReveal);
  if (actions.onDismiss) add('Dismiss', 'is-ghost', actions.onDismiss);
  if (actions.onResolve) add('Mark resolved', '', actions.onResolve);

  if (!any) tools.remove();
}

export function renderCard(
  parent: HTMLElement,
  check: StoredCheck,
  actions: CardActions,
  options: CardOptions = {},
): HTMLElement {
  const verdict = check.verdict;
  const asked = isQuestion(check);
  const card = parent.createDiv({
    cls: `recall-card${verdict ? ` recall-${verdict}` : ''}${asked ? ' is-question' : ''}`,
  });
  card.dataset.checkId = check.id;

  // The span this is about, so a card in the leaf is legible without going
  // back to the prose to find out what it refers to. A question put to the
  // whole note, or the next line of a thread, has none.
  if (hasSpan(check)) {
    card.createDiv({ cls: 'recall-card-quote', text: trim(check.quote, 120) });
  }
  // In full, unlike the quote: it is the reader's own sentence, and the answer
  // under it is an answer to all of it.
  if (asked) card.createDiv({ cls: 'recall-card-question', text: check.question ?? '' });

  if (options.running) {
    card.createDiv({
      cls: 'recall-card-status',
      text: asked ? 'Working on an answer…' : 'Reading your explanation…',
    });
    return card;
  }

  if (isUnfinished(check)) {
    card.createDiv({
      cls: 'recall-card-status',
      text: asked
        ? 'This question never got its answer. It is saved.'
        : 'This check never came back. Your highlight is saved.',
    });
    renderTools(card, { onRetry: actions.onRetry, onDismiss: actions.onDismiss });
    return card;
  }

  if (verdict) {
    card.createDiv({ cls: `recall-verdict recall-${verdict}`, text: VERDICT_LABELS[verdict] });
  }
  renderBody(card, check, options.children ?? [], actions.onOpenChild);
  renderTools(card, actions);

  if (options.replies) {
    card.createDiv({
      cls: 'recall-card-replies',
      text: options.replies === 1 ? '1 reply' : `${options.replies} replies`,
    });
  }

  if (options.questionable) {
    card.createDiv({
      cls: 'recall-card-hint',
      text: 'Select any part of this and right-click to check it or ask about it.',
    });
  }

  if (actions.onOpen) {
    card.addClass('is-openable');
    card.addEventListener('click', actions.onOpen);
  }
  return card;
}
