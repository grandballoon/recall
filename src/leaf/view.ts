/* The checks and questions for the note you are looking at.
 *
 * One leaf that retargets as you move between notes, the way Outline and
 * Backlinks do — a pattern readers already have, and one that gets per-note
 * pinning for free from Obsidian's own leaf pin rather than from us.
 *
 * The margin-comment layout of the other two surfaces does not survive the
 * port: a leaf is a panel, not a gutter. What the reader sees is the same
 * shape either way — the writing, with the cards to one side of it.
 *
 * The leaf is two regions. The cards scroll, and are rebuilt whenever the
 * note's checks change; the box a question is typed into sits under them and
 * is built once, so nothing half-typed is lost to an answer arriving.
 *
 * This file talks to the rest of the plugin through `LeafHost` rather than
 * importing it, so the view and `main.ts` do not depend on each other.
 */
import { ItemView, Menu, type WorkspaceLeaf } from 'obsidian';

import type { CheckStore } from '../store/store';
import type { CheckSession, NoteChecks } from '../session/session';
import { hasSpan, isFollowUp, isQuestion, type StoredCheck } from '../store/format';
import { childrenOf, noteChecks, unanchoredChecks } from '../session/session';
import { OFFSET_ATTR, renderCard } from './card';
import { offsetsFromSelection } from './body';
import { Composer } from './composer';
import { trim } from '../check/outcome';

export const RECALL_VIEW_TYPE = 'recall-checks';

export interface Span {
  from: number;
  to: number;
  quote: string;
}

/** What a question is about. A span with no parent is a span of the note; a
 *  span with one addresses that card's stored body string. No span at all is
 *  the note as a whole, or the next line of the parent's thread. */
export interface AskTarget {
  parentId: string | null;
  span: Span | null;
}

export interface LeafHost {
  readonly session: CheckSession;
  readonly store: CheckStore;
  /** Makes sure a note's checks are loaded. The leaf renders synchronously,
   *  so it asks for this and re-renders when the session says so. */
  ensureLoaded(path: string): void;
  /** Scrolls to a check's span and selects it. `force` also switches a note
   *  being read into editing mode, which only the explicit action does. */
  reveal(path: string, id: string, force?: boolean): void;
  /** True when some editor is showing this note's text — a note open in
   *  Reading mode is not, and has no span to reach. */
  isEditing(path: string): boolean;
  /** Retries the unanchored checks against the note's current text. */
  reanchor(path: string): void;
  /** Check ids with a request in flight right now. */
  isRunning(id: string): boolean;
  /** Asks again for a check that never came back. */
  retry(path: string, id: string): void;
  /** A span of one card's note was selected and questioned. The offsets
   *  address that card's stored body string, not the document. */
  askAboutCard(path: string, parentId: string, span: Span): void;
  /** Puts a question to Claude and records it. Resolves to the new card's id,
   *  or to null when it could not be asked — the host says why. */
  ask(path: string, target: AskTarget, question: string): Promise<string | null>;
}

export class RecallView extends ItemView {
  private path: string | null = null;
  private stopListening: (() => void) | null = null;
  /** The thread being read, root first. Empty means the list of every check
   *  on the note, which is where the leaf starts. */
  private stack: string[] = [];
  /** A span the reader picked to ask about and has not asked about yet. */
  private pending: (Span & { parentId: string | null }) | null = null;
  private cardsEl: HTMLElement | null = null;
  private composer!: Composer;

  constructor(leaf: WorkspaceLeaf, private readonly host: LeafHost) {
    super(leaf);
  }

  override getViewType(): string {
    return RECALL_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'Recall';
  }

  override getIcon(): string {
    return 'highlighter';
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('recall-leaf');
    this.cardsEl = this.contentEl.createDiv({ cls: 'recall-cards' });
    this.composer = new Composer(this.contentEl, {
      onSubmit: (question) => void this.submit(question),
      onDropSpan: () => {
        this.pending = null;
        this.render();
        this.composer.focus();
      },
    });

    this.stopListening = this.host.session.onChange((path) => {
      if (path === this.path) this.render();
    });
    // Both events matter: one for opening a note, one for moving between tabs
    // that are already open.
    this.registerEvent(this.app.workspace.on('file-open', () => this.retarget()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.retarget()));
    this.retarget();
  }

  override async onClose(): Promise<void> {
    this.stopListening?.();
    this.stopListening = null;
    if (this.path) this.host.session.lit(this.path, null);
  }

  /** Points the leaf at whatever note is in front.
   *
   *  Renders every time rather than only when the note changes: the same note
   *  switched from Reading to Editing mode offers a different action on every
   *  card, and that switch arrives as a leaf change with the path unmoved.
   *  Loading, which is the part with a cost, still happens only on a move. */
  private retarget(): void {
    const file = this.app.workspace.getActiveFile();
    // A canvas, a PDF or an image is not a target. Treating those as an
    // absence of checks is both true and free.
    const path = file && file.extension === 'md' ? file.path : null;

    if (path !== this.path) {
      if (this.path) this.host.session.lit(this.path, null);
      this.moveTo(path);
    }
    this.render();
  }

  /** Everything that is about one note in particular goes when the note
   *  does. What is typed in the box stays: it is the reader's, and they can
   *  see for themselves which note it is now pointed at. */
  private moveTo(path: string | null): void {
    this.path = path;
    this.stack = [];
    this.pending = null;
    if (path) this.host.ensureLoaded(path);
  }

  /** Called by the plugin when a check is asked for, so the leaf shows the
   *  card it is about to fill rather than waiting for the answer. */
  focus(path: string, id: string): void {
    if (this.path !== path) this.moveTo(path);
    // A question about a card belongs to a thread, so the leaf follows it in
    // rather than dropping the reader back at the list.
    this.stack = this.threadTo(id);
    this.render();
    this.scrollTo(id);
  }

  /** Called by the plugin when the reader wants to ask something: puts the
   *  cursor in the box, pointed at the span they had selected if there was
   *  one. Without a span the leaf stays where it is, so the question lands in
   *  whatever is open — the note, or the thread being read. */
  compose(path: string, span: Span | null): void {
    if (this.path !== path) this.moveTo(path);
    if (span) {
      // A span of the note starts a thread of its own, so the leaf steps out
      // of whichever one it was in.
      this.stack = [];
      this.pending = { ...span, parentId: null };
    }
    this.render();
    this.composer.focus();
  }

  private scrollTo(id: string): void {
    const card = this.cardsEl?.querySelector(`[data-check-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ block: 'nearest' });
  }

  render(): void {
    const el = this.cardsEl;
    // The plugin can ask for a render before the leaf has finished opening.
    if (!el) return;
    el.empty();

    const path = this.path;
    const note = path ? this.host.session.peek(path) : null;

    // A span picked from a card that has since been dismissed is a span of
    // nothing.
    if (this.pending?.parentId && !note?.byId.has(this.pending.parentId)) this.pending = null;
    // A thread is read in place of the list, not alongside it: depth stays
    // inside the single leaf, as the card stack it already is.
    const top = this.stack[this.stack.length - 1];
    if (top === undefined || !note?.byId.has(top)) this.stack = [];

    this.composer.update({
      enabled: path !== null && note !== null,
      about: this.pending?.quote ?? null,
      placeholder: !path
        ? 'Open a note to ask about it.'
        : this.pending
          ? 'Ask about this span…'
          : this.stack.length > 0
            ? 'Ask a follow-up…'
            : 'Ask about this note…',
    });

    if (!path) {
      this.renderEmpty(el, 'Open a note to see its checks.');
      return;
    }
    if (!note) {
      this.renderEmpty(el, 'Loading…');
      return;
    }

    // A file we could not read is never written over, and never silently
    // treated as a note with no checks — that failure is the one worth
    // saying out loud, because seeding over it is total.
    const why = this.host.store.whyUnreadable(path);
    if (why !== null) {
      const banner = el.createDiv({ cls: 'recall-banner is-warning' });
      banner.createEl('strong', { text: 'Recall is not saving checks for this note.' });
      banner.createEl('p', {
        text: `Its saved checks could not be read, because ${why}. Nothing has been overwritten — fix or remove that file and reopen the note.`,
      });
    }

    if (this.stack.length > 0) {
      this.renderThread(el, path, note);
      return;
    }

    const stranded = unanchoredChecks(note);
    const live = noteChecks(note).filter((c) => !c.resolved && c.unanchored !== true);

    if (stranded.length === 0 && live.length === 0) {
      this.renderEmpty(
        el,
        'Nothing on this note yet. Select a span and check it, or ask a question below.',
      );
      return;
    }

    if (stranded.length > 0) this.renderStranded(el, path, stranded);
    if (live.length > 0) this.renderChecks(el, path, live, note);
  }

  /** The reader pressed Enter. What the question is about is decided here:
   *  the span they picked if there is one, and otherwise whatever is open. */
  private async submit(question: string): Promise<void> {
    const path = this.path;
    if (!path) return;

    const picked = this.pending;
    const target: AskTarget = picked
      ? { parentId: picked.parentId, span: { from: picked.from, to: picked.to, quote: picked.quote } }
      : { parentId: this.stack[this.stack.length - 1] ?? null, span: null };

    this.composer.setBusy(true);
    const id = await this.host.ask(path, target, question);
    this.composer.setBusy(false);
    // Refused: the host has said why, and the words stay in the box.
    if (id === null || this.path !== path) return;

    this.composer.clear();
    this.pending = null;
    if (target.span === null && target.parentId !== null) {
      // The next line of the thread that is open. The leaf stays in it.
      this.render();
      this.scrollTo(id);
    } else {
      // A thread of its own, which the leaf follows so that the next thing
      // typed is a follow-up to it.
      this.focus(path, id);
    }
    this.composer.focus();
  }

  /** The path from a top-level check down to this one. */
  private threadTo(id: string): string[] {
    const note = this.path ? this.host.session.peek(this.path) : null;
    if (!note) return [];

    const path: string[] = [];
    let at: string | null = id;
    // Guarded against a cycle a hand-edited file could introduce: a parent
    // chain that loops would otherwise hang the leaf rather than fail.
    const seen = new Set<string>();
    while (at && !seen.has(at)) {
      seen.add(at);
      const check = note.byId.get(at);
      if (!check) break;
      path.unshift(check.id);
      at = check.parentId;
    }
    return path;
  }

  /** What hangs off a card, as the two different things it can be: questions
   *  about some part of it, which are highlights inside it, and follow-ups,
   *  which are the conversation under it. */
  private under(note: NoteChecks, id: string): { branches: StoredCheck[]; followUps: StoredCheck[] } {
    const children = childrenOf(note, id);
    return {
      branches: children.filter((c) => !isFollowUp(c)),
      followUps: children.filter(isFollowUp),
    };
  }

  /** One thread: a trail of where you are, the card you are reading, and the
   *  conversation that has followed it. */
  private renderThread(parent: HTMLElement, path: string, note: NoteChecks): void {
    const section = parent.createDiv({ cls: 'recall-section is-thread' });

    const back = section.createEl('button', { cls: 'recall-btn is-ghost recall-back', text: '← All checks' });
    back.addEventListener('click', () => {
      this.stack = [];
      this.host.session.lit(path, null);
      this.render();
    });

    if (this.stack.length > 1) this.renderCrumbs(section, note);

    const id = this.stack[this.stack.length - 1]!;
    const check = note.byId.get(id)!;
    const { branches, followUps } = this.under(note, id);

    // Only a card with a span in the prose has anything to reveal there: a
    // question about a card's note, or one put to the whole note, does not.
    const revealable = check.parentId === null && hasSpan(check);
    const editing = this.host.isEditing(path);

    const card = renderCard(
      section,
      check,
      {
        onReveal: revealable && !editing ? () => this.host.reveal(path, id, true) : undefined,
        // A follow-up is a line of a conversation, not a mark on the prose,
        // so there is nothing for resolving it to take off.
        onResolve: isFollowUp(check) ? undefined : () => this.resolveAndLeave(path, id),
        onDismiss: () => this.dismissAndLeave(path, id),
        onRetry: () => this.host.retry(path, id),
        onOpenChild: (childId) => this.openThread(path, childId),
      },
      { running: this.host.isRunning(id), children: branches, questionable: true },
    );
    this.wireQuestioning(card, path, id);

    if (followUps.length === 0) return;
    const replies = section.createDiv({ cls: 'recall-replies' });
    for (const reply of followUps) {
      const below = this.under(note, reply.id);
      const replyCard = renderCard(
        replies,
        reply,
        {
          // A follow-up that has grown a conversation of its own is read as
          // its own thread; one that has not is read right here.
          onOpen: below.followUps.length > 0 ? () => this.openThread(path, reply.id) : undefined,
          onDismiss: () => this.host.session.remove(path, reply.id),
          onRetry: () => this.host.retry(path, reply.id),
          onOpenChild: (childId) => this.openThread(path, childId),
        },
        {
          running: this.host.isRunning(reply.id),
          children: below.branches,
          replies: below.followUps.length,
        },
      );
      this.wireQuestioning(replyCard, path, reply.id);
    }
  }

  /** Opens a thread and puts the prose alongside it.
   *
   *  Revealing happens here rather than while rendering: a render runs again
   *  every time an assessment lands, and re-scrolling the editor under the
   *  reader each time would be its own small disaster. */
  private openThread(path: string, id: string): void {
    this.stack = this.threadTo(id);
    this.render();

    const root = this.stack[0];
    if (root && this.host.isEditing(path)) this.host.reveal(path, root);
  }

  private renderCrumbs(parent: HTMLElement, note: NoteChecks): void {
    const nav = parent.createDiv({ cls: 'recall-crumbs' });
    this.stack.forEach((id, i) => {
      if (i > 0) nav.createSpan({ cls: 'recall-crumb-sep', text: '›' });
      const check = note.byId.get(id);
      if (!check) return;

      // Named for its span where it has one, and for what was asked where it
      // does not.
      const name = hasSpan(check) ? check.quote : (check.question ?? '');
      const crumb = nav.createEl('button', {
        cls: `recall-crumb${i === this.stack.length - 1 ? ' is-current' : ''}`,
      });
      crumb.createSpan({
        cls: `recall-dot${check.verdict ? ` recall-${check.verdict}` : ''}`,
      });
      crumb.createSpan({ cls: 'recall-crumb-text', text: trim(name, 24) });
      crumb.setAttribute('aria-label', name);
      if (i !== this.stack.length - 1) {
        crumb.addEventListener('click', () => {
          this.stack = this.stack.slice(0, i + 1);
          this.render();
        });
      }
    });
  }

  /** Selecting part of a card's note and questioning it.
   *
   *  A context menu rather than anything floating: it is the same idiom as
   *  checking a span in the editor, it needs no layer of its own, and it
   *  behaves the same under every community theme. */
  private wireQuestioning(card: HTMLElement, path: string, parentId: string): void {
    const body = card.querySelector('.recall-card-body');
    if (!(body instanceof HTMLElement)) return;

    body.addEventListener('contextmenu', (event) => {
      const selection = this.containerEl.win.getSelection();
      if (!selection || selection.isCollapsed) return;

      const span = offsetsFromSelection(selection, (node) => startOffsetOf(node, body));
      if (!span) return;

      const quote = selection.toString();
      if (quote.trim() === '') return;

      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle('Check this with Recall')
          .setIcon('highlighter')
          .onClick(() => this.host.askAboutCard(path, parentId, { ...span, quote })),
      );
      menu.addItem((item) =>
        item
          .setTitle('Ask Recall about this')
          .setIcon('message-circle')
          .onClick(() => {
            this.pending = { ...span, quote, parentId };
            this.render();
            this.composer.focus();
          }),
      );
      menu.showAtMouseEvent(event);
    });
  }

  private resolveAndLeave(path: string, id: string): void {
    this.host.session.resolve(path, id);
    this.leaveIfGone(path, id);
  }

  private dismissAndLeave(path: string, id: string): void {
    this.host.session.remove(path, id);
    this.leaveIfGone(path, id);
  }

  /** A card that has just been dealt with should not stay open in front of
   *  the reader; the thread falls back to its parent, or to the list. */
  private leaveIfGone(path: string, id: string): void {
    const note = this.host.session.peek(path);
    const still = note?.byId.get(id);
    if (still && !still.resolved) return;
    this.stack = this.stack.slice(0, this.stack.indexOf(id));
    this.render();
  }

  private renderEmpty(parent: HTMLElement, message: string): void {
    parent.createDiv({ cls: 'recall-empty' }).createEl('p', { text: message });
  }

  private renderHeading(parent: HTMLElement, text: string): HTMLElement {
    const heading = parent.createDiv({ cls: 'recall-section-heading' });
    heading.createSpan({ text });
    return heading;
  }

  /** Checks whose span an edit took away. Persistent, ignorable, and moving
   *  nothing until asked — the desktop app's repair notice, with a new
   *  address. */
  private renderStranded(parent: HTMLElement, path: string, stranded: StoredCheck[]): void {
    const section = parent.createDiv({ cls: 'recall-section is-stranded' });
    const one = stranded.length === 1;
    const heading = this.renderHeading(
      section,
      one ? 'One check has lost its span' : `${stranded.length} checks have lost their spans`,
    );

    const button = heading.createEl('button', { cls: 'recall-btn is-ghost', text: 'Put them back' });
    button.addEventListener('click', () => this.host.reanchor(path));

    section.createEl('p', {
      cls: 'recall-section-note',
      text: one
        ? 'Its text is no longer in this note, so there is nothing to open it from. The assessment is kept.'
        : 'Their text is no longer in this note, so there is nothing to open them from. The assessments are kept.',
    });

    for (const check of stranded) {
      renderCard(
        section,
        check,
        {
          onRetry: () => this.host.retry(path, check.id),
          onDismiss: () => this.host.session.remove(path, check.id),
        },
        { running: this.host.isRunning(check.id) },
      );
    }
  }

  private renderChecks(
    parent: HTMLElement,
    path: string,
    checks: StoredCheck[],
    note: NoteChecks,
  ): void {
    const section = parent.createDiv({ cls: 'recall-section' });
    this.renderHeading(section, countOf(checks));

    const editing = this.host.isEditing(path);
    for (const check of checks) {
      const { branches, followUps } = this.under(note, check.id);
      renderCard(
        section,
        check,
        {
          // In Reading mode there is no span to reach, so clicking the card
          // does nothing and the explicit action is the way in.
          // Opening a card in the list means reading its thread. Revealing
          // the span in the prose comes with it when there is one to reveal.
          onOpen: () => this.openThread(path, check.id),
          onReveal: editing || !hasSpan(check) ? undefined : () => this.host.reveal(path, check.id, true),
          onResolve: () => this.host.session.resolve(path, check.id),
          onDismiss: () => this.host.session.remove(path, check.id),
          onRetry: () => this.host.retry(path, check.id),
        },
        {
          running: this.host.isRunning(check.id),
          children: branches,
          replies: followUps.length,
        },
      );
    }
  }
}

/** The heading over the list: how many of each thing is in it. */
function countOf(checks: readonly StoredCheck[]): string {
  const questions = checks.filter(isQuestion).length;
  const parts: string[] = [];
  const count = (n: number, word: string): void => {
    if (n > 0) parts.push(`${n} ${word}${n === 1 ? '' : 's'}`);
  };
  count(checks.length - questions, 'check');
  count(questions, 'question');
  return parts.join(' · ');
}

/** Walks up from a selected node to the run that carries its offset. */
function startOffsetOf(node: Node | null, within: HTMLElement): number | null {
  let at: Node | null = node;
  while (at && at !== within) {
    if (at instanceof HTMLElement) {
      const offset = at.getAttribute(OFFSET_ATTR);
      if (offset !== null) return Number(offset);
    }
    at = at.parentNode;
  }
  return null;
}
