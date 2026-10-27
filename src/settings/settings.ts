/* What the reader can change, and what it means — with nothing Obsidian in it.
 *
 * The tab that renders these lives next door in `tab.ts`, which is the only
 * half that imports `obsidian`. The same split as `checker/protocol.ts` and
 * `checker/index.ts`, and for the same reason: the rules are worth asserting
 * headless, and the widgets are not.
 *
 * Two stores, for one reason. The preferences go through `loadData`/`saveData`
 * into the plugin's `data.json`, which is inside the vault and syncs — that is
 * correct for a model choice and wrong for a key. The key goes to one file
 * outside the vault; see `key/keyfile.ts`. Nothing here ever holds the key,
 * and the field that takes it never shows it back.
 */
import { EFFORTS, MODEL, MODELS, type Effort } from '../checker/protocol';

export interface RecallSettings {
  model: string;
  /** Null sends no effort at all, which is the API's own default. */
  effort: Effort | null;
  /** Placeholder cards instead of real checks. On by default until a key is
   *  added, and available afterwards for anyone who wants to stop spending. */
  demoMode: boolean;
}

export const DEFAULT_SETTINGS: RecallSettings = {
  model: MODEL,
  effort: null,
  demoMode: false,
};

/** Old or hand-edited `data.json` is not trusted to be the right shape: an
 *  unknown model would fail every check with a 404 that reads like a key
 *  problem, which is a bad way to find out. */
export function normaliseSettings(raw: unknown): RecallSettings {
  const given = (raw ?? {}) as Partial<RecallSettings>;
  const known = MODELS.some((m) => m.id === given.model);
  return {
    model: known ? given.model! : DEFAULT_SETTINGS.model,
    effort: EFFORTS.includes(given.effort as Effort) ? (given.effort as Effort) : null,
    demoMode: given.demoMode === true,
  };
}

