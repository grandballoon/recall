/* Where a question is typed.
 *
 * One box at the foot of the leaf, for every question there is to ask: about
 * the note, about a span of it, about a span of a card, or as the next line of
 * the thread that is open. What it is about is the leaf's business — this only
 * shows it, takes the words, and hands them over.
 *
 * It is built once and kept, rather than drawn with the cards. The cards are
 * rebuilt every time an answer lands, and a box that was rebuilt with them
 * would lose whatever was half-typed in it at the time.
 */
import { trim } from '../check/outcome';

export interface ComposerState {
  /** False when there is nothing to ask about — no note in front. */
  enabled: boolean;
  placeholder: string;
  /** The span the next question is about, or null when it is about the note
   *  or the open thread as a whole. */
  about: string | null;
}

export interface ComposerHandlers {
  onSubmit(question: string): void;
  /** The reader let go of the span they had picked. */
  onDropSpan(): void;
}

export class Composer {
  private readonly aboutEl: HTMLElement;
  private readonly quoteEl: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly button: HTMLButtonElement;
  private enabled = false;

  constructor(parent: HTMLElement, private readonly handlers: ComposerHandlers) {
    const el = parent.createDiv({ cls: 'recall-composer' });

    this.aboutEl = el.createDiv({ cls: 'recall-composer-about' });
    this.quoteEl = this.aboutEl.createSpan({ cls: 'recall-composer-quote' });
    const drop = this.aboutEl.createEl('button', {
      cls: 'recall-btn is-ghost recall-composer-drop',
      text: '×',
    });
    drop.setAttribute('aria-label', 'Ask about the note instead of this span');
    drop.addEventListener('click', () => this.handlers.onDropSpan());

    const row = el.createDiv({ cls: 'recall-composer-row' });
    this.input = row.createEl('textarea', { cls: 'recall-composer-input' });
    this.input.rows = 1;
    this.button = row.createEl('button', { cls: 'recall-btn mod-cta', text: 'Ask' });
    this.button.setAttribute('aria-label', 'Ask (Cmd+Enter)');

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (event) => {
      // Enter breaks the line, as it does in the note beside it, and
      // Cmd+Enter sends — Ctrl+Enter where there is no Cmd key. A question is
      // often more than one line, and sending one by accident costs a call.
      // An Enter that is confirming an IME composition is neither.
      if (event.key !== 'Enter' || event.isComposing) return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      this.submit();
    });
    this.button.addEventListener('click', () => this.submit());

    this.update({ enabled: false, placeholder: '', about: null });
  }

  private submit(): void {
    if (!this.enabled || this.input.value.trim() === '') return;
    this.handlers.onSubmit(this.input.value.trim());
  }

  /** Grows the box with what is in it, up to the height the stylesheet caps
   *  it at, and keeps the button honest about whether there is anything to
   *  send. */
  private refresh(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${this.input.scrollHeight}px`;
    this.button.disabled = !this.enabled || this.input.value.trim() === '';
  }

  update(state: ComposerState): void {
    this.enabled = state.enabled;
    this.input.disabled = !state.enabled;
    this.input.placeholder = state.placeholder;

    this.aboutEl.toggleClass('is-hidden', state.about === null);
    this.quoteEl.setText(state.about === null ? '' : trim(state.about, 120));
    this.refresh();
  }

  /** Stops a second Enter from asking the same thing twice while the first
   *  is being recorded. */
  setBusy(busy: boolean): void {
    this.input.disabled = busy || !this.enabled;
    this.button.disabled = busy || !this.enabled || this.input.value.trim() === '';
  }

  /** Only once a question has actually been asked: one that was refused keeps
   *  its words, so the reader does not have to type them again. */
  clear(): void {
    this.input.value = '';
    this.refresh();
  }

  focus(): void {
    this.input.focus();
  }
}
