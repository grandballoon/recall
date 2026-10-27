/* The Rust suite these came from is in `src-tauri/src/claude.rs`; the wire
 * contract is the thing two surfaces now share, so it is asserted the same
 * way on both. The cases past `an answer with no text block` are new, and
 * cover what serde used to give the Rust side for free. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CheckerError,
  MODEL,
  VERDICTS,
  apiMessage,
  askRequest,
  assessRequest,
  parseMessage,
  parseReply,
  statusError,
  type Verdict,
} from './protocol';

function messageBody(fields: Record<string, unknown>): unknown {
  return { stop_reason: 'end_turn', content: [], ...fields };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    assert.ok(e instanceof CheckerError, `expected a CheckerError, got ${e}`);
    return e.code;
  }
  assert.fail('expected a throw');
}

test('the request pins the wire contract', () => {
  const body = assessRequest('the whole page', 'the span') as any;

  assert.equal(body.model, MODEL);
  assert.equal(body.max_tokens, 16_000);
  assert.equal(body.thinking.type, 'adaptive');
  // Opt-in refusal fallback; paired with the beta header on the request.
  assert.equal(body.fallbacks, 'default');

  assert.equal(body.output_config.format.type, 'json_schema');
  const schema = body.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['verdict', 'note']);
  assert.deepEqual(schema.properties.verdict.enum, ['wrong', 'imprecise', 'missing', 'solid']);
});

test('the request sends the page whole and caches it ahead of the span', () => {
  const page = 'a'.repeat(20_000);
  const body = assessRequest(page, 'the span') as any;
  const content = body.messages[0].content;

  assert.equal(content.length, 2);
  // The page is never truncated, and carries the cache breakpoint so a second
  // check on the same page reads it from cache.
  assert.ok(content[0].text.includes(page));
  assert.equal(content[0].cache_control.type, 'ephemeral');
  assert.ok(content[1].text.includes('the span'));
  assert.equal(content[1].cache_control, undefined);
});

test('the system prompt still names all four verdicts and scopes the assessment', () => {
  const body = assessRequest('page', 'span') as any;
  for (const verdict of VERDICTS) assert.ok(body.system.includes(`"${verdict}"`));
  assert.ok(body.system.includes('Assess ONLY the highlighted span'));
});

test('reads the answer past a thinking block', () => {
  const assessment = parseMessage(
    messageBody({
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: '{"verdict":"solid","note":"Right, and Kepler\'s second law is why."}' },
      ],
    }),
  );

  assert.equal(assessment.verdict, 'solid');
  assert.ok(assessment.note.startsWith('Right,'));
});

test('every verdict round-trips', () => {
  for (const wire of VERDICTS) {
    const assessment = parseMessage(
      messageBody({ content: [{ type: 'text', text: `{"verdict":"${wire}","note":"n"}` }] }),
    );
    assert.equal(assessment.verdict, wire, `verdict ${wire} did not round-trip`);
  }
});

test('a refusal is not reported as a verdict', () => {
  assert.equal(codeOf(() => parseMessage(messageBody({ stop_reason: 'refusal' }))), 'refusal');
});

test('a truncated answer is flagged rather than parsed', () => {
  const code = codeOf(() =>
    parseMessage(
      messageBody({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"verdict":"sol' }] }),
    ),
  );
  assert.equal(code, 'malformed');
});

test('an answer with no text block is flagged', () => {
  const code = codeOf(() =>
    parseMessage(messageBody({ content: [{ type: 'thinking', thinking: '' }] })),
  );
  assert.equal(code, 'malformed');
});

test('an answer outside the verdict set is flagged rather than trusted', () => {
  // serde gave the Rust side this for free; in TypeScript the enum is only a
  // compile-time claim, so a wire value has to be checked at the boundary.
  const code = codeOf(() =>
    parseMessage(messageBody({ content: [{ type: 'text', text: '{"verdict":"great","note":"n"}' }] })),
  );
  assert.equal(code, 'malformed');
});

test('an answer missing its note is flagged rather than trusted', () => {
  const code = codeOf(() =>
    parseMessage(messageBody({ content: [{ type: 'text', text: '{"verdict":"solid"}' }] })),
  );
  assert.equal(code, 'malformed');
});

test('a status maps onto the code the UI branches on', () => {
  const cases: Array<[number, string]> = [
    [401, 'auth'],
    [403, 'auth'],
    [404, 'no_model_access'],
    [429, 'rate_limited'],
    [500, 'overloaded'],
    [529, 'overloaded'],
    [418, 'api'],
  ];
  for (const [status, code] of cases) {
    assert.equal(statusError(status, '').code, code, `status ${status} mapped wrong`);
  }
});

test('an API error reports the message the API gave, or the body it actually sent', () => {
  assert.equal(apiMessage('{"error":{"message":"credit balance is too low"}}'), 'credit balance is too low');
  assert.equal(apiMessage('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>');
  assert.ok(statusError(400, '{"error":{"message":"bad span"}}').message.includes('bad span'));
});

test('a verdict is the only thing a caller can act on', () => {
  // Guards the type at the value level: the UI keys its palette off these.
  const painted: Verdict[] = [...VERDICTS];
  assert.deepEqual(painted, ['wrong', 'imprecise', 'missing', 'solid']);
});

/* ---------- questions ---------- */

test('a question is sent as a conversation, with the page cached ahead of it', () => {
  const page = 'a'.repeat(20_000);
  const body = askRequest(page, [
    { role: 'user', text: 'first ask' },
    { role: 'assistant', text: 'first answer' },
    { role: 'user', text: 'the follow-up' },
  ]) as any;

  assert.equal(body.model, MODEL);
  assert.equal(body.thinking.type, 'adaptive');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(
    body.messages.map((m: any) => m.role),
    ['user', 'assistant', 'user'],
  );

  // The page rides on the first turn only, whole, and is the one breakpoint.
  const [first, second, third] = body.messages;
  assert.equal(first.content.length, 2);
  assert.ok(first.content[0].text.includes(page));
  assert.deepEqual(first.content[0].cache_control, { type: 'ephemeral' });
  assert.equal(first.content[1].text, 'first ask');
  assert.deepEqual(second.content, [{ type: 'text', text: 'first answer' }]);
  assert.deepEqual(third.content, [{ type: 'text', text: 'the follow-up' }]);
});

test('a question asks for prose, not for the verdict schema', () => {
  const plain = askRequest('page', [{ role: 'user', text: 'why?' }]) as any;
  assert.equal(plain.output_config, undefined);

  const cheaper = askRequest('page', [{ role: 'user', text: 'why?' }], { effort: 'low' }) as any;
  assert.deepEqual(cheaper.output_config, { effort: 'low' });
});

test('an answer is the text of the reply, past whatever precedes it', () => {
  const body = messageBody({
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '  Because the inner membrane is where it happens.\n' },
    ],
  });

  assert.equal(parseReply(body), 'Because the inner membrane is where it happens.');
});

test('a question that got no answer says why', () => {
  assert.equal(codeOf(() => parseReply(messageBody({ stop_reason: 'refusal' }))), 'refusal');
  assert.equal(codeOf(() => parseReply(messageBody({ stop_reason: 'max_tokens' }))), 'malformed');
  assert.equal(codeOf(() => parseReply(messageBody({ content: [{ type: 'thinking' }] }))), 'malformed');
  assert.equal(codeOf(() => parseReply(messageBody({ content: [{ type: 'text', text: '  ' }] }))), 'malformed');
});
