// A pane's endpoint is the full API URL; its path picks the format:
//
//   .../chat/completions   OpenAI-compatible chat completions (system + user message)
//   .../completions        OpenAI-compatible text completions (both joined into one prompt)
//   .../decisions          OpenRouter Decisions API (see decisions.js)
//   mock://...             random answers, no API (see server.js)

export const FORMATS = ['chat', 'completions', 'decisions', 'mock'];

// -> one of FORMATS, or null for an unknown path.
export function endpointFormat(endpoint) {
  if (typeof endpoint !== 'string') return null;
  if (endpoint.startsWith('mock://')) return 'mock';
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/completions')) return 'completions';
  if (path.endsWith('/decisions')) return 'decisions';
  return null;
}

// Throws with a hint at a valid endpoint.
export function checkEndpoint(endpoint) {
  if (endpointFormat(endpoint)) return endpoint;
  const hint = /\/v1\/?$/.test(endpoint ?? '') ? ` (a base URL? use ${String(endpoint).replace(/\/+$/, '')}/chat/completions)` : '';
  throw new Error(
    `endpoint ${JSON.stringify(endpoint)} must be a full API URL ending in /chat/completions, /completions or /decisions, or mock://random${hint}`,
  );
}

// Reasoning models on OpenRouter (e.g. openai/gpt-6-luna) spend max_tokens on hidden reasoning and
// return content null unless reasoning is off. Sent only to OpenRouter: others may reject it.
const isOpenRouter = (endpoint) => {
  try {
    return /(^|\.)openrouter\.ai$/.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};

export function buildChatRequest({ endpoint, model, systemPrompt, userMessage, temperature }) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 1,
    temperature,
    stream: false,
    ...(isOpenRouter(endpoint) && { reasoning: { effort: 'none' } }),
  };
}

// First string in message.content: the string itself, or the first text part of an array;
// anything else gives ''.
export function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
  }
  return '';
}

export function parseChatResponse(body) {
  const choice = body.choices?.[0];
  return { raw: chatContent(choice?.message?.content), finish_reason: choice?.finish_reason ?? null };
}

// A chat reply may be a word, empty or null instead of an action. Re-ask up to CHAT_OUTPUT_RETRIES
// times, then throw err.code 'unexpected_output' (the browser stops the match).
// send() -> { body, latency_ms }; parseAction(raw) -> action or null. latency_ms sums all attempts.
export const CHAT_OUTPUT_RETRIES = 5;

export async function requestChatAction(send, parseAction, retries = CHAT_OUTPUT_RETRIES) {
  const rejected = [];
  let latency_ms = 0;
  for (;;) {
    const resp = await send();
    latency_ms += resp.latency_ms;
    const out = parseChatResponse(resp.body);
    if (parseAction(out.raw) !== null) {
      return { ...out, latency_ms, retries: rejected.length, ...(rejected.length && { rejected }) };
    }
    rejected.push(out.raw);
    if (rejected.length > retries) {
      const err = new Error(
        `unexpected output ${rejected.length} times in a row (${rejected.map((r) => JSON.stringify(r)).join(', ')}): not an action`,
      );
      throw Object.assign(err, { code: 'unexpected_output', rejected });
    }
  }
}

// The user message ends with "Action:", so the model answers right after it.
export function buildCompletionsRequest({ model, systemPrompt, userMessage, temperature }) {
  return { model, prompt: `${systemPrompt}\n\n${userMessage}`, max_tokens: 1, temperature, stream: false };
}

export function parseCompletionsResponse(body) {
  const choice = body.choices?.[0];
  return { raw: choice?.text ?? '', finish_reason: choice?.finish_reason ?? null };
}
