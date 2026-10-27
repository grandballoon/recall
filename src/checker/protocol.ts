/* The wire contract for one span check, and for one question — and nothing
 * else.
 *
 * Ported from `src-tauri/src/claude.rs`, which held the same boundary for the
 * desktop app: "here is what they wrote, here is the span they highlighted"
 * in, a typed verdict out. Everything here is pure, so the request shape and
 * every failure path can be asserted without spending a token or touching
 * Obsidian. The transport lives next door in `index.ts`.
 */

export const API_BASE = 'https://api.anthropic.com/v1';
export const API_VERSION = '2023-06-01';

/** Server-side refusal fallback: if a safety classifier declines the request,
 *  the API re-runs it on a fallback model within the same call instead of
 *  handing back an empty answer. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The default, and the one the product is designed around: span checking is
 *  a knowledge-and-discrimination task across arbitrary subject matter, and a
 *  confidently-wrong correction in a study tool is worse than none — the
 *  reader calibrates against it and memorises the error. */
export const MODEL = 'claude-opus-5';

/** What settings offers instead, in the order to reach for them.
 *
 *  Effort is the first lever, because it keeps the model that is good at this
 *  and spends less thinking on it. Only then a smaller model. */
export const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5 — the most careful reader (default)' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — faster and cheaper' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — cheapest' },
] as const;

export const EFFORTS = ['high', 'medium', 'low'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface CheckOptions {
  model?: string;
  /** Left off entirely by default, which is the API's own default effort. */
  effort?: Effort | null;
}

const MAX_TOKENS = 16_000;

/** Adaptive thinking on a hard span can take a while; this is a ceiling, not
 *  a target. `requestUrl` has no timeout of its own, so this one is enforced
 *  by the caller rather than the transport. */
export const TIMEOUT_MS = 120_000;

export const VERDICTS = ['wrong', 'imprecise', 'missing', 'solid'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Assessment {
  verdict: Verdict;
  note: string;
}

const SYSTEM_PROMPT = `You are a precise, generous tutor helping someone test their understanding through active recall. They wrote an explanation from memory, highlighted one span of it, and asked you to check that span.

Assess ONLY the highlighted span. Read the surrounding text for context, but do not grade the rest of it.

Choose exactly one verdict:
- "wrong": the span asserts something false.
- "imprecise": broadly right, but vague, misleading, or sloppy in a way that matters.
- "missing": the span gestures at something real but omits the part that carries the meaning.
- "solid": the span is correct and precise enough.

Then write a note of one to three sentences. If the verdict is wrong or imprecise, say what is off and give the correction. If it is missing, name what a complete answer would add. If it is solid, confirm it crisply and add one enriching detail. Be specific to this material — never generic study advice.`;

/** A failure the UI can react to differently depending on `code`.
 *
 *  The desktop app's `keychain` and `store` codes are gone with the Rust that
 *  raised them; the key now lives in a file this plugin reads, and the library
 *  is the vault. */
export type CheckerErrorCode =
  | 'not_connected'
  | 'network'
  | 'auth'
  | 'no_model_access'
  | 'rate_limited'
  | 'overloaded'
  | 'api'
  | 'malformed'
  | 'refusal';

export class CheckerError extends Error {
  readonly code: CheckerErrorCode;

  constructor(code: CheckerErrorCode, message: string) {
    super(message);
    this.name = 'CheckerError';
    this.code = code;
  }

  static notConnected(): CheckerError {
    return new CheckerError(
      'not_connected',
      'Claude is not connected yet. Add an API key in Settings.',
    );
  }

  static timedOut(): CheckerError {
    return new CheckerError('network', 'Claude took too long to answer.');
  }
}

/** The Messages API request for one span check.
 *
 *  Split out from the call so the wire shape can be asserted in tests without
 *  spending a token. */
export function assessRequest(
  fullText: string,
  span: string,
  options: CheckOptions = {},
): Record<string, unknown> {
  const effort = options.effort ?? null;
  return {
    model: options.model || MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    fallbacks: 'default',
    output_config: {
      ...(effort ? { effort } : {}),
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: [...VERDICTS] },
            note: { type: 'string' },
          },
          required: ['verdict', 'note'],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Their full explanation:\n\n<explanation>\n${fullText}\n</explanation>`,
            // Checking several spans of one unedited page replays this prefix;
            // the breakpoint lets those checks read it from cache.
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `The highlighted span to assess:\n\n<span>\n${span}\n</span>`,
          },
        ],
      },
    ],
  };
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

/** The words of a Messages API response, or why there are none.
 *
 *  Thinking blocks (and, on a rescued refusal, a fallback block) precede the
 *  answer, so the text has to be picked out rather than indexed. `what` names
 *  the thing that was being asked for, for the sentence the reader sees. */
function answerText(body: unknown, what: string): string {
  const message = (body ?? {}) as { content?: unknown; stop_reason?: unknown };

  if (message.stop_reason === 'refusal') {
    throw new CheckerError('refusal', `Claude declined to ${what}.`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new CheckerError('malformed', "Claude's answer was cut off before it finished.");
  }

  const blocks: ContentBlock[] = Array.isArray(message.content) ? message.content : [];
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (text.trim() === '') {
    throw new CheckerError('malformed', 'Claude returned no answer.');
  }
  return text;
}

/** Turns a Messages API response body into an assessment, or says why not. */
export function parseMessage(body: unknown): Assessment {
  const text = answerText(body, 'assess this passage');

  // The request constrains the output to the schema above, so anything
  // unparseable here is a genuine surprise rather than a formatting slip.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CheckerError(
      'malformed',
      `Claude's answer did not match the expected shape: ${(e as Error).message}`,
    );
  }

  const answer = (parsed ?? {}) as { verdict?: unknown; note?: unknown };
  if (!isVerdict(answer.verdict) || typeof answer.note !== 'string') {
    throw new CheckerError(
      'malformed',
      "Claude's answer did not match the expected shape: missing verdict or note",
    );
  }

  return { verdict: answer.verdict, note: answer.note };
}

/* ---------- questions ---------- */

/** One side of a conversation, as the API reads it. */
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Plain prose is asked for because of where the answer goes: a card renders
 *  its text as runs that keep their offsets, so that any part of an answer can
 *  itself be selected and questioned. Markdown would arrive as literal syntax. */
const ASK_SYSTEM_PROMPT = `You are a precise, generous tutor helping someone test their understanding through active recall. They wrote an explanation from memory and are now asking you about it: about a span they highlighted, about something you said earlier, or about the material itself.

Answer the question they asked, directly and specifically to this material. If their explanation gets something wrong that bears on the question, say so plainly and give the correction. Do not rewrite their explanation for them unless they ask you to — the recalling is theirs to do.

Be brief: a few sentences, more only when the question needs it. Your reply is shown as plain text in a narrow side panel, so write in plain prose with no markdown — no headings, lists, bold, or tables. Short inline code is fine where the subject is code.`;

/** The Messages API request for one question.
 *
 *  `turns` is the conversation so far, oldest first, ending with the question
 *  being asked. The page goes ahead of all of it and is cached, exactly as it
 *  is for a check, so a thread of follow-ups on one unedited note replays the
 *  prefix rather than paying for it each time. */
export function askRequest(
  fullText: string,
  turns: readonly Turn[],
  options: CheckOptions = {},
): Record<string, unknown> {
  const effort = options.effort ?? null;
  const page = {
    type: 'text',
    text: `My full explanation:\n\n<explanation>\n${fullText}\n</explanation>`,
    cache_control: { type: 'ephemeral' },
  };

  return {
    model: options.model || MODEL,
    max_tokens: MAX_TOKENS,
    system: ASK_SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    fallbacks: 'default',
    ...(effort ? { output_config: { effort } } : {}),
    messages: turns.map((turn, i) => ({
      role: turn.role,
      content: [...(i === 0 ? [page] : []), { type: 'text', text: turn.text }],
    })),
  };
}

/** Claude's answer to a question, or why there is none. */
export function parseReply(body: unknown): string {
  return answerText(body, 'answer this').trim();
}

/** Pulls `error.message` out of an API error body, falling back to whatever
 *  the body actually was. */
export function apiMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    return typeof message === 'string' ? message : body;
  } catch {
    return body;
  }
}

/** Maps a non-2xx response onto a code the UI can act on. */
export function statusError(status: number, body: string): CheckerError {
  switch (status) {
    case 401:
    case 403:
      return new CheckerError(
        'auth',
        'That API key was rejected. Check it in Settings, or create a new one.',
      );
    case 404:
      return new CheckerError('no_model_access', 'The key works, but it cannot reach that model.');
    case 429:
      return new CheckerError(
        'rate_limited',
        'Rate limited by the API. Wait a moment and try again.',
      );
    case 500:
    case 529:
      return new CheckerError('overloaded', 'The API is busy right now.');
    default:
      return new CheckerError('api', `The API returned ${status}: ${apiMessage(body)}`);
  }
}
