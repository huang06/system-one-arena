import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatRequest,
  buildCompletionsRequest,
  CHAT_OUTPUT_RETRIES,
  chatContent,
  checkEndpoint,
  endpointFormat,
  parseChatResponse,
  parseCompletionsResponse,
  requestChatAction,
} from '../endpoints.js';
import { parseAction } from '../public/games/snake/engine.js';

test('the endpoint path picks the format', () => {
  assert.equal(endpointFormat('https://api.openai.com/v1/chat/completions'), 'chat');
  assert.equal(endpointFormat('https://openrouter.ai/api/v1/chat/completions/'), 'chat');
  assert.equal(endpointFormat('http://127.0.0.1:8000/v1/chat/completions'), 'chat');
  assert.equal(endpointFormat('https://api.openai.com/v1/completions'), 'completions');
  assert.equal(endpointFormat('https://openrouter.ai/api/alpha/decisions'), 'decisions');
  assert.equal(endpointFormat('mock://random'), 'mock');
  assert.equal(endpointFormat('https://api.openai.com/v1'), null);
  assert.equal(endpointFormat('https://openrouter.ai/api/v1/chat/completions?x=1'), 'chat');
  assert.equal(endpointFormat('ftp://example.com/v1/chat/completions'), null);
  assert.equal(endpointFormat('not a url'), null);
  assert.equal(endpointFormat(undefined), null);
});

test('checkEndpoint explains what a valid endpoint looks like', () => {
  assert.equal(checkEndpoint('https://openrouter.ai/api/alpha/decisions'), 'https://openrouter.ai/api/alpha/decisions');
  assert.throws(() => checkEndpoint('https://api.openai.com/v1'), /use https:\/\/api\.openai\.com\/v1\/chat\/completions/);
  assert.throws(() => checkEndpoint('https://example.com/generate'), /\/chat\/completions, \/completions or \/decisions/);
});

test('chat and text completions requests and responses', () => {
  const args = { model: 'm', systemPrompt: 'Rules.', userMessage: 'State\n\nAction:', temperature: 0 };
  assert.deepEqual(buildChatRequest(args), {
    model: 'm',
    messages: [{ role: 'system', content: 'Rules.' }, { role: 'user', content: 'State\n\nAction:' }],
    max_tokens: 1,
    temperature: 0,
    stream: false,
  });
  assert.deepEqual(buildCompletionsRequest(args), {
    model: 'm', prompt: 'Rules.\n\nState\n\nAction:', max_tokens: 1, temperature: 0, stream: false,
  });
  assert.deepEqual(parseChatResponse({ choices: [{ message: { content: 'L' }, finish_reason: 'length' }] }), { raw: 'L', finish_reason: 'length' });
  assert.deepEqual(parseCompletionsResponse({ choices: [{ text: ' R', finish_reason: 'length' }] }), { raw: ' R', finish_reason: 'length' });
  assert.deepEqual(parseCompletionsResponse({}), { raw: '', finish_reason: null });
});

test('chat requests to OpenRouter turn reasoning off', () => {
  const args = { model: 'openai/gpt-6-luna', systemPrompt: 'Rules.', userMessage: 'Action:', temperature: 0 };
  assert.deepEqual(buildChatRequest({ ...args, endpoint: 'https://openrouter.ai/api/v1/chat/completions' }).reasoning, { effort: 'none' });
  assert.equal('reasoning' in buildChatRequest({ ...args, endpoint: 'https://api.openai.com/v1/chat/completions' }), false);
  assert.equal('reasoning' in buildChatRequest({ ...args, endpoint: 'https://notopenrouter.ai/v1/chat/completions' }), false);
});

test('raw is the first string in message.content', () => {
  assert.equal(chatContent('U'), 'U');
  assert.equal(chatContent([{ type: 'text', text: 'R' }, { type: 'text', text: 'L' }]), 'R');
  assert.equal(chatContent([{ type: 'image_url' }, 'D']), 'D');
  assert.equal(chatContent(null), '');
  assert.equal(chatContent(undefined), '');
  assert.deepEqual(parseChatResponse({ choices: [{ message: { content: null }, finish_reason: 'length' }] }), { raw: '', finish_reason: 'length' });
});

// A fake upstream that answers with the given contents in order.
function upstream(contents) {
  let calls = 0;
  const send = async () => ({
    body: { choices: [{ message: { content: contents[calls++] }, finish_reason: 'stop' }] },
    latency_ms: 10,
  });
  return { send, calls: () => calls };
}

test('a chat reply that is an action is used at once', async () => {
  const up = upstream(['L']);
  assert.deepEqual(await requestChatAction(up.send, parseAction), { raw: 'L', finish_reason: 'stop', latency_ms: 10, retries: 0 });
  assert.equal(up.calls(), 1);
});

test('unexpected chat output is asked again', async () => {
  const up = upstream([null, 'Hmm', ' ', 'up']);
  assert.deepEqual(await requestChatAction(up.send, parseAction), {
    raw: 'up', finish_reason: 'stop', latency_ms: 40, retries: 3, rejected: ['', 'Hmm', ' '],
  });
});

test(`unexpected chat output ${CHAT_OUTPUT_RETRIES + 1} times in a row fails the step`, async () => {
  assert.equal(CHAT_OUTPUT_RETRIES, 5);
  // The 6th answer (5th retry) still succeeds.
  const ok = upstream(['x', 'x', 'x', 'x', 'x', 'R']);
  assert.equal((await requestChatAction(ok.send, parseAction)).retries, 5);

  const bad = upstream(['x', 'x', 'x', 'x', 'x', 'x', 'R']);
  await assert.rejects(requestChatAction(bad.send, parseAction), (err) => {
    assert.equal(err.code, 'unexpected_output');
    assert.deepEqual(err.rejected, ['x', 'x', 'x', 'x', 'x', 'x']);
    assert.match(err.message, /6 times in a row/);
    return true;
  });
  assert.equal(bad.calls(), 6);
});

test('API errors are not unexpected output', async () => {
  const send = async () => {
    throw Object.assign(new Error('upstream HTTP 500'), { status: 500 });
  };
  await assert.rejects(requestChatAction(send, parseAction), (err) => err.status === 500 && err.code === undefined);
});
