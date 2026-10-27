/* Which editors are showing which file — and how a check reaches all of them.
 *
 * `registerEditorExtension` applies to every editor, and each `EditorView`
 * keeps its own `StateField`, so a split pane holds a second decoration set
 * for the same note. Rather than walking the workspace to find those views —
 * which since 1.7.2 means stepping around `DeferredView`s that have no editor
 * yet — the views register themselves here as they are constructed, and
 * `editorInfoField` says which file each one is on. A view that does not
 * exist yet simply registers when it loads.
 *
 * This is also why the plugin never reaches for `editor.cm`: an extension is
 * handed its own view, so there is nothing to reach for.
 */
import type { StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';

import { checkField, checksIn, litCheck, setChecks, type Check } from './field';

export interface DroppedReport {
  path: string;
  /** Checks whose span the user just deleted. They keep their records — the
   *  caller marks them unanchored rather than forgetting them. */
  ids: readonly string[];
}

function pathOf(view: EditorView): string | null {
  const info = view.state.field(editorInfoField, false);
  return info?.file?.path ?? null;
}

export class ViewRegistry {
  private readonly views = new Map<EditorView, string | null>();

  /** Called when an edit deletes a checked span. Set by the plugin. */
  onDropped: ((report: DroppedReport) => void) | null = null;
  /** Called when an edit moves checked spans, with their new positions. */
  onMoved: ((path: string, checks: readonly Check[]) => void) | null = null;
  /** Called when an editor appears that we have not drawn into yet — a split
   *  pane, or a tab that was deferred until the user opened it. */
  onAttached: ((path: string) => void) | null = null;

  attach(view: EditorView): void {
    const path = pathOf(view);
    this.views.set(view, path);
    if (!path) return;
    // A view plugin is constructed during the view's own update, and CM6
    // forbids dispatching into a view mid-update. This hands the broadcast
    // back to the plugin once that has finished.
    setTimeout(() => {
      if (this.views.has(view) && this.onAttached) this.onAttached(path);
    }, 0);
  }

  detach(view: EditorView): void {
    this.views.delete(view);
  }

  /** A view can outlive the file it shows — the same leaf opens another note
   *  without being torn down. */
  refresh(view: EditorView): void {
    if (this.views.has(view)) this.views.set(view, pathOf(view));
  }

  viewsFor(path: string): EditorView[] {
    const found: EditorView[] = [];
    for (const [view, at] of this.views) if (at === path) found.push(view);
    return found;
  }

  /** The broadcast: plugin data is authoritative, and every view of that file
   *  is told the same thing. */
  dispatch(path: string, effects: StateEffect<unknown> | StateEffect<unknown>[]): void {
    for (const view of this.viewsFor(path)) view.dispatch({ effects });
  }

  report(view: EditorView, ids: readonly string[]): void {
    const path = this.views.get(view) ?? pathOf(view);
    if (path && this.onDropped) this.onDropped({ path, ids });
  }

  reportMoved(view: EditorView, checks: readonly Check[]): void {
    const path = this.views.get(view) ?? pathOf(view);
    if (path && this.onMoved) this.onMoved(path, checks);
  }

  /** The document as an editor currently holds it, which is what a check must
   *  anchor against — the file on disk may be a keystroke behind. */
  docFor(path: string): string | null {
    const [view] = this.viewsFor(path);
    return view ? view.state.doc.toString() : null;
  }

  /* The two halves of `Broadcaster`, which is how the session reaches the
     editors without knowing what an `EditorView` is. */

  setChecks(path: string, checks: readonly Check[]): void {
    this.dispatch(path, setChecks.of(checks));
  }

  lit(path: string, id: string | null): void {
    this.dispatch(path, litCheck.of(id));
  }
}

function recallViewPlugin(registry: ViewRegistry) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      constructor(private readonly view: EditorView) {
        registry.attach(view);
      }

      update(update: ViewUpdate): void {
        registry.refresh(update.view);
        const { set, dropped } = update.state.field(checkField);
        if (dropped.length) registry.report(update.view, dropped);
        // CM6 has already mapped the surviving spans; this is what keeps the
        // stored offsets from drifting behind the text.
        if (update.docChanged) registry.reportMoved(update.view, checksIn(set));
      }

      destroy(): void {
        registry.detach(this.view);
      }
    },
  );
}

/** Everything the editor needs, in the order `registerEditorExtension` wants
 *  it. The field first, so the view plugin can read it on its first update. */
export function recallEditorExtension(registry: ViewRegistry) {
  return [checkField, recallViewPlugin(registry)];
}
