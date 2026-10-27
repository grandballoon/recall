/* The only module that talks to the Anthropic API.
 *
 * Raw HTTP rather than `@anthropic-ai/sdk`: a plugin runs in Obsidian's
 * renderer, where `fetch` to api.anthropic.com is blocked by CORS. Obsidian's
 * `requestUrl` runs outside the renderer and is the sanctioned way out, so the
 * wire shape is ours to build — which is what `protocol.ts` is for.
 *
 * Demo-mode fallback and the deliberate blank verdict on a failed check are
 * the UI's business, as they were on the other two surfaces. This module
 * either returns an assessment or throws a `CheckerError` saying why not.
 */
import { requestUrl } from 'obsidian';

import {
  API_BASE,
  API_VERSION,
  CheckerError,
  FALLBACK_BETA,
  MODEL,
  TIMEOUT_MS,
  askRequest,
  assessRequest,
  parseMessage,
  parseReply,
  statusError,
  type Assessment,
  type CheckOptions,
  type Turn,
} from './protocol';

export {
  CheckerError,
  EFFORTS,
  MODEL,
  MODELS,
  VERDICTS,
  type Assessment,
  type CheckerErrorCode,
  type CheckOptions,
  type Effort,
  type Turn,
  type Verdict,
} from './protocol';

/** `requestUrl` takes no timeout and cannot be aborted, so this stops us
 *  waiting rather than stopping the request. The UI gets its "try again"
 *  path back either way. */
async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(CheckerError.timedOut()), TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

/** Anything that isn't already a `CheckerError` failed before it got a status
 *  — no network, DNS, TLS. */
function transportError(e: unknown): CheckerError {
  if (e instanceof CheckerError) return e;
  return new CheckerError('network', `Could not reach Claude: ${(e as Error)?.message ?? e}`);
}

/** Confirms a key both authenticates and can reach the model this plugin
 *  uses. Costs no tokens. */
export async function verifyKey(apiKey: string, model: string = MODEL): Promise<void> {
  if (!apiKey) throw CheckerError.notConnected();

  let response;
  try {
    response = await withTimeout(
      requestUrl({
        url: `${API_BASE}/models/${model}`,
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
        throw: false,
      }),
    );
  } catch (e) {
    throw transportError(e);
  }

  if (response.status >= 200 && response.status < 300) return;
  throw statusError(response.status, response.text);
}

/** One Messages API call: the request in, the parsed response body out. Both
 *  things this plugin asks Claude for go through here, so they fail the same
 *  way and say the same things about it. */
async function send(apiKey: string, request: Record<string, unknown>): Promise<unknown> {
  if (!apiKey) throw CheckerError.notConnected();

  let response;
  try {
    response = await withTimeout(
      requestUrl({
        url: `${API_BASE}/messages`,
        method: 'POST',
        contentType: 'application/json',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-beta': FALLBACK_BETA,
        },
        body: JSON.stringify(request),
        // Without this, `requestUrl` throws on 400+ and takes the status with
        // it; we want the status and the body to map onto our own codes.
        throw: false,
      }),
    );
  } catch (e) {
    throw transportError(e);
  }

  if (response.status < 200 || response.status >= 300) {
    throw statusError(response.status, response.text);
  }

  try {
    return JSON.parse(response.text);
  } catch (e) {
    throw new CheckerError(
      'malformed',
      `Could not read Claude's response: ${(e as Error).message}`,
    );
  }
}

export async function assess(
  apiKey: string,
  fullText: string,
  span: string,
  options: CheckOptions = {},
): Promise<Assessment> {
  return parseMessage(await send(apiKey, assessRequest(fullText, span, options)));
}

/** Puts a question to Claude. `turns` is the conversation so far, ending with
 *  the question; see `ask/conversation.ts` for how a thread becomes one. */
export async function ask(
  apiKey: string,
  fullText: string,
  turns: readonly Turn[],
  options: CheckOptions = {},
): Promise<string> {
  return parseReply(await send(apiKey, askRequest(fullText, turns, options)));
}
