/* The plugin entry point.
 *
 * Stages land here in the order at the end of README.md: the checker module
 * needs nothing registered, the decoration field needs an editor extension,
 * persistence needs the vault events that keep the store honest about where
 * notes have gone, and the leaf needs a view, the commands that open it, and
 * the one that asks for a check in the first place.
 *
 * This file is the only one that knows both halves of the plugin. The session
 * reaches the editors through an interface the registry satisfies, and the
 * leaf reaches the plugin through `LeafHost`, so nothing below this file
 * imports anything above it.
 */
import {
  Editor,
  MarkdownFileInfo,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';

import { resolveAnchor } from './anchor/anchoring';
import { ViewRegistry, recallEditorExtension } from './anchor/registry';
import { conversationFor } from './ask/conversation';
import { ask, assess } from './checker';
import { KeyFile, openKeyFile } from './key/keyfile';
import { DEFAULT_SETTINGS, normaliseSettings, type RecallSettings } from './settings/settings';
import { RecallSettingTab, type SettingsHost } from './settings/tab';
import {
  demoOutcome,
  demoReply,
  failureOutcome,
  failureReply,
  inFrontmatter,
  pageText,
  type Outcome,
  type Reply,
} from './check/outcome';
import { CheckSession } from './session/session';
import { hasSpan, isQuestion } from './store/format';
import { CheckStore } from './store/store';
import { RECALL_VIEW_TYPE, RecallView, type AskTarget, type LeafHost, type Span } from './leaf/view';

export default class RecallPlugin extends Plugin implements LeafHost, SettingsHost {
  private readonly views = new ViewRegistry();
  private readonly running = new Set<string>();
  override settings: RecallSettings = DEFAULT_SETTINGS;
  keyFile: KeyFile = openKeyFile();
  store!: CheckStore;
  session!: CheckSession;

  override async onload(): Promise<void> {
    this.settings = normaliseSettings(await this.loadData());
    this.addSettingTab(new RecallSettingTab(this.app, this));

    this.store = new CheckStore(this.app.vault.adapter, this.checksFolder());
    this.session = new CheckSession(this.store, this.views);

    this.views.onDropped = (report) => this.session.dropped(report.path, report.ids);
    this.views.onMoved = (path, checks) => this.session.moved(path, checks);
    // A split pane, or a tab that was deferred until it was opened, starts
    // with no decorations of its own. This is what fills it.
    this.views.onAttached = (path) => this.ensureLoaded(path);
    this.registerEditorExtension(recallEditorExtension(this.views));

    this.registerView(RECALL_VIEW_TYPE, (leaf) => new RecallView(leaf, this));

    // A path is the key, so the store has to hear about a path changing.
    // `registerEvent` detaches all of these when the plugin unloads.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.session.renamed(oldPath, file.path);
        void this.store.handleRename(oldPath, file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile)) return;
        this.session.forget(file.path);
        void this.store.handleDelete(file.path);
      }),
    );
    // A note restored from the trash arrives as a create. Without this, its
    // checks stay marked as a deleted note's and the next prune destroys them.
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile) void this.store.handleCreate(file.path);
      }),
    );

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        if (!editor.somethingSelected() || !info.file) return;
        menu.addItem((item) =>
          item
            .setTitle('Check this span with Recall')
            .setIcon('highlighter')
            .onClick(() => void this.checkSelection(editor, info)),
        );
        menu.addItem((item) =>
          item
            .setTitle('Ask Recall about this span')
            .setIcon('message-circle')
            .onClick(() => void this.askSelection(editor, info)),
        );
      }),
    );

    this.addCommands();
  }

  private addCommands(): void {
    // All unbound by default, which the community guidelines ask for in as
    // many words. The ids are stable, because a hotkey binds to one.
    this.addCommand({
      id: 'check-selection',
      name: 'Check the selected span',
      editorCheckCallback: (checking, editor, info) => {
        if (!editor.somethingSelected() || !info.file) return false;
        if (!checking) void this.checkSelection(editor, info);
        return true;
      },
    });

    this.addCommand({
      id: 'ask-selection',
      name: 'Ask about the selected span',
      editorCheckCallback: (checking, editor, info) => {
        if (!editor.somethingSelected() || !info.file) return false;
        if (!checking) void this.askSelection(editor, info);
        return true;
      },
    });

    this.addCommand({
      id: 'ask-note',
      name: 'Ask about this note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.compose(file.path, null);
        return true;
      },
    });

    this.addCommand({
      id: 'open-checks',
      name: 'Open the checks panel',
      callback: () => void this.openLeaf(),
    });

    this.addCommand({
      id: 'reanchor-checks',
      name: 'Put lost checks back on their spans',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) this.reanchor(file.path);
        return true;
      },
    });

    this.addCommand({
      id: 'prune-deleted-checks',
      name: 'Prune checks for deleted notes',
      callback: () => void this.pruneDeleted(),
    });
  }

  override async onunload(): Promise<void> {
    // Whatever was still queued when the plugin went away.
    await this.store.flush();
  }

  private checksFolder(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/checks`;
  }

  /* ---------- asking for a check ---------- */

  /** Where the note's frontmatter ends, or 0 if it has none. Frontmatter is
   *  metadata rather than writing: it is not checked, and it is not sent. */
  private frontmatterEnd(file: TFile): number {
    return this.app.metadataCache.getFileCache(file)?.frontmatterPosition?.end?.offset ?? 0;
  }

  /** The span selected in an editor, or null — having said why — when it is
   *  not one Recall will take. */
  private selectedSpan(editor: Editor, file: TFile): (Span & { doc: string }) | null {
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    if (from >= to) {
      new Notice('Select a span first.');
      return null;
    }
    if (inFrontmatter(from, this.frontmatterEnd(file))) {
      new Notice("That span is in the note's frontmatter, which Recall does not read.");
      return null;
    }

    const doc = editor.getValue();
    return { from, to, quote: doc.slice(from, to), doc };
  }

  private async checkSelection(editor: Editor, info: MarkdownFileInfo): Promise<void> {
    const file = info.file;
    const span = file && this.selectedSpan(editor, file);
    if (!file || !span) return;
    const { doc, ...anchor } = span;

    // Loaded before it is added to, so a note's existing checks are not
    // clobbered by a session that starts with only the new one in it.
    await this.session.open(file.path, doc);
    const check = this.session.add(file.path, { span: anchor });

    await this.openLeaf(false);
    this.leafView()?.focus(file.path, check.id);

    await this.runCheck(file.path, check.id, anchor.quote, pageText(doc, this.frontmatterEnd(file)));
  }

  /** The reader wants to ask about a span rather than have it checked. Nothing
   *  is recorded yet: the span goes to the leaf, which holds it until the
   *  question has been typed. */
  private async askSelection(editor: Editor, info: MarkdownFileInfo): Promise<void> {
    const file = info.file;
    const span = file && this.selectedSpan(editor, file);
    if (!file || !span) return;

    const { doc: _doc, ...anchor } = span;
    await this.compose(file.path, anchor);
  }

  private async compose(path: string, span: Span | null): Promise<void> {
    await this.openLeaf();
    this.leafView()?.compose(path, span);
  }

  /** A span of one card's note was questioned.
   *
   *  The offsets address that card's stored body string rather than the
   *  document, so nothing here touches an editor. What Claude reads is the
   *  note under discussion together with the writing it was about, because the
   *  span being questioned lives in the first and only makes sense with the
   *  second. */
  askAboutCard(path: string, parentId: string, span: Span): void {
    const parent = this.session.peek(path)?.byId.get(parentId);
    if (!parent) return;

    const check = this.session.add(path, { span, parentId });
    this.leafView()?.focus(path, check.id);

    void this.contextFor(path, parent.body).then((page) =>
      this.runCheck(path, check.id, span.quote, page),
    );
  }

  private async runCheck(path: string, id: string, quote: string, page: string): Promise<void> {
    this.running.add(id);
    this.leafView()?.render();

    let outcome: Outcome;
    const apiKey = this.apiKey();
    if (apiKey === null) {
      outcome = demoOutcome(quote, this.demoReason());
    } else {
      try {
        const assessment = await assess(apiKey, page, quote, this.checkOptions());
        outcome = {
          verdict: assessment.verdict,
          body: assessment.note.trim() || 'No comment returned.',
        };
      } catch (error) {
        outcome = failureOutcome(error, quote);
      }
    }

    this.running.delete(id);
    this.session.assessed(path, id, outcome.verdict, outcome.body);
  }

  /* ---------- asking a question ---------- */

  async ask(path: string, target: AskTarget, question: string): Promise<string | null> {
    if (target.parentId !== null) {
      // About a card, or the next line under one. Its span, if it has one,
      // addresses that card's stored text, so there is no document to consult.
      if (!this.session.peek(path)?.byId.has(target.parentId)) return null;
      const check = this.session.add(path, { ...target, question });
      void this.runAsk(path, check.id);
      return check.id;
    }

    const doc = await this.docOf(path);
    if (doc === null) {
      new Notice('Open that note to ask about it.');
      return null;
    }

    let span: Span | null = null;
    if (target.span) {
      // The span was picked before the question was typed, and the note may
      // have been edited in between. It goes where its text now is, or — if
      // that text is gone or no longer unique — nowhere, because a question
      // pinned to the wrong sentence is worse than one that has to be re-asked.
      const found = resolveAnchor(doc, target.span);
      if (found.kind !== 'exact' && found.kind !== 'quote') {
        new Notice('That span has changed since you selected it. Select it again to ask about it.');
        return null;
      }
      span = { from: found.from, to: found.to, quote: target.span.quote };
    }

    await this.session.open(path, doc);
    const check = this.session.add(path, { span, question });
    void this.runAsk(path, check.id);
    return check.id;
  }

  private async runAsk(path: string, id: string): Promise<void> {
    // Read before anything is awaited, so the conversation sent is the one
    // the reader was looking at when they asked.
    const note = this.session.peek(path);
    const turns = note ? conversationFor(note.byId, id) : [];
    if (turns.length === 0) return;

    this.running.add(id);
    this.leafView()?.render();

    let reply: Reply;
    const apiKey = this.apiKey();
    if (apiKey === null) {
      reply = demoReply(this.demoReason());
    } else {
      try {
        const page = await this.contextFor(path, null);
        reply = { body: await ask(apiKey, page, turns, this.checkOptions()), failed: false };
      } catch (error) {
        reply = failureReply(error);
      }
    }

    this.running.delete(id);
    this.session.answered(path, id, reply.body, reply.failed);
  }

  private checkOptions(): { model: string; effort: RecallSettings['effort'] } {
    return { model: this.settings.model, effort: this.settings.effort };
  }

  private demoReason(): 'chosen' | 'no-key' {
    return this.settings.demoMode ? 'chosen' : 'no-key';
  }

  async saveSettings(): Promise<void> {
    // Preferences only. The key is never in here — it lives in one file
    // outside the vault, because `data.json` syncs and a key must not.
    await this.saveData(this.settings);
  }

  /** The key to check with, or null for the demo path — no key on this
   *  device, or demo mode asked for deliberately. */
  private apiKey(): string | null {
    if (this.settings.demoMode) return null;
    return this.keyFile.read();
  }

  /* ---------- the leaf ---------- */

  private leafView(): RecallView | null {
    for (const leaf of this.app.workspace.getLeavesOfType(RECALL_VIEW_TYPE)) {
      if (leaf.view instanceof RecallView) return leaf.view;
    }
    return null;
  }

  private async openLeaf(focus = true): Promise<void> {
    const [existing] = this.app.workspace.getLeavesOfType(RECALL_VIEW_TYPE);
    if (existing) {
      if (focus) await this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: RECALL_VIEW_TYPE, active: focus });
    if (focus) await this.app.workspace.revealLeaf(leaf);
  }

  /* ---------- LeafHost ---------- */

  /** A note's text, or null if there is no note there.
   *
   *  The editor's copy is authoritative when there is one: the file on disk
   *  can be a keystroke behind, and a check anchors against what is on screen.
   *  Everything that needs to anchor, re-anchor or send a note comes through
   *  here, so they all agree about which copy that is. */
  private async docOf(path: string): Promise<string | null> {
    const live = this.views.docFor(path);
    if (live !== null) return live;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      // The store reports its own read failures; this one is the note itself,
      // and a note we cannot read has no checks to draw.
      return null;
    }
  }

  ensureLoaded(path: string): void {
    if (this.session.redraw(path)) return;
    void this.docOf(path).then((text) => {
      if (text !== null) void this.session.open(path, text);
    });
  }

  isEditing(path: string): boolean {
    return this.markdownViewFor(path)?.getMode() === 'source';
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  reanchor(path: string): void {
    void this.docOf(path).then((text) => {
      if (text === null) return;
      const { placed, stuck } = this.session.reanchor(path, text);
      if (placed === 0 && stuck === 0) return;
      new Notice(
        placed === 0
          ? `Could not put ${stuck === 1 ? 'that check' : 'those checks'} back: the text is no longer in this note, or appears more than once.`
          : `Put ${placed} check${placed === 1 ? '' : 's'} back${stuck ? `, ${stuck} still unplaced` : ''}.`,
      );
    });
  }

  retry(path: string, id: string): void {
    const note = this.session.peek(path);
    const check = note?.byId.get(id);
    if (!check) return;

    if (isQuestion(check)) {
      void this.runAsk(path, id);
      return;
    }

    // A question about a card is re-asked with the card's material, not the
    // document's — the same context it was asked with the first time.
    const parent = check.parentId === null ? null : note?.byId.get(check.parentId);
    void this.contextFor(path, parent?.body ?? null).then((page) =>
      this.runCheck(path, id, check.quote, page),
    );
  }

  /** What Claude reads as "the page".
   *
   *  The note's own writing, with the frontmatter stripped, plus — when the
   *  span being checked lives inside an assessment rather than in the note —
   *  that assessment, because the span only makes sense alongside both. */
  private async contextFor(path: string, cardBody: string | null): Promise<string> {
    const doc = await this.docOf(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    const note = doc === null ? '' : pageText(doc, file instanceof TFile ? this.frontmatterEnd(file) : 0);
    return [note, cardBody ?? ''].filter((part) => part !== '').join('\n\n');
  }

  reveal(path: string, id: string, force = false): void {
    void this.revealSpan(path, id, force);
  }

  private markdownLeafFor(path: string): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) return leaf;
    }
    return null;
  }

  private markdownViewFor(path: string): MarkdownView | null {
    const leaf = this.markdownLeafFor(path);
    return leaf && leaf.view instanceof MarkdownView ? leaf.view : null;
  }

  private async revealSpan(path: string, id: string, force: boolean): Promise<void> {
    const check = this.session.peek(path)?.byId.get(id);
    // A question put to the whole note has no span to go to.
    if (!check || check.unanchored || !hasSpan(check)) return;

    const leaf = this.markdownLeafFor(path);
    if (!leaf || !(leaf.view instanceof MarkdownView)) {
      new Notice('Open that note to reveal this check.');
      return;
    }

    if (leaf.view.getMode() !== 'source') {
      // Changing someone's view mode is their call, so only the explicit
      // action does it. A plain click on a card in Reading mode does nothing.
      if (!force) return;
      const state = leaf.getViewState();
      await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } });
    }

    // The view may have been rebuilt by the mode change, so it is looked up
    // again rather than held across the await.
    const view = this.markdownViewFor(path);
    if (!view) return;

    const { editor } = view;
    const from = editor.offsetToPos(check.from);
    const to = editor.offsetToPos(check.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    this.session.lit(path, id);
  }

  private async pruneDeleted(): Promise<void> {
    // The vault, not the flag, decides whether a note is gone.
    const pruned = await this.store.prune(
      (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
    );
    for (const path of pruned) this.session.forget(path);
    new Notice(
      pruned.length === 0
        ? 'No checks to prune — every note they belong to still exists.'
        : `Pruned checks for ${pruned.length} deleted note${pruned.length === 1 ? '' : 's'}.`,
    );
  }
}
