// Static file server + LLM proxy (chat / text completions or the OpenRouter Decisions API, per
// pane endpoint). API keys never leave this process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES } from './public/games/registry.js';
import {
  actionCriteria,
  buildDecisionsRequest,
  decisionQuestion,
  isDecisionsOnlyError,
  parseDecisionsResponse,
} from './decisions.js';
import {
  buildChatRequest,
  buildCompletionsRequest,
  checkEndpoint,
  endpointFormat,
  parseCompletionsResponse,
  requestChatAction,
} from './endpoints.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
const PANE_IDS = ['A', 'B', 'C', 'D']; // assigned to bots in order
const MIN_PANES = 2;

// Each engine supplies the system prompt, action letters (for the mock) and output parser.
// A game whose engine fails to load is skipped.
const engines = {};
const criteria = {}; // Decisions API options per game, from the prompt's "Actions:" block
for (const { id } of GAMES) {
  try {
    const engine = await import(`./public/games/${id}/engine.js`);
    if (typeof engine.SYSTEM_PROMPT !== 'string' || typeof engine.ACTIONS !== 'string' || typeof engine.parseAction !== 'function') {
      throw new Error('engine must export SYSTEM_PROMPT and ACTIONS strings and parseAction()');
    }
    criteria[id] = actionCriteria(engine.SYSTEM_PROMPT, engine.ACTIONS);
    engines[id] = engine;
  } catch (err) {
    console.warn(`skipping game "${id}": ${err.message}`);
  }
}

const PANE_FIELDS = ['endpoint', 'api_key', 'model', 'temperature'];
// Legacy fields: base_url + api ("auto" / "chat" / "decisions") became endpoint.
const RENAMED = { base_url: 'endpoint (the full API URL)', api: 'endpoint (its path picks the API)' };

function defaultPane(id) {
  const env = (k) => process.env[`PANE_${id}_${k}`];
  for (const old of Object.keys(RENAMED)) {
    if (env(old.toUpperCase()) !== undefined) {
      throw new Error(`PANE_${id}_${old.toUpperCase()} is no longer supported; set PANE_${id}_ENDPOINT to the full API URL`);
    }
  }
  return {
    endpoint: env('ENDPOINT') || 'mock://random',
    api_key: env('API_KEY') || '',
    model: env('MODEL') || 'mock-random',
    temperature: env('TEMPERATURE') !== undefined ? Number(env('TEMPERATURE')) : 0,
  };
}

// config.json lists bots in order ({ "panes": [{ endpoint, api_key, model, temperature }, ...] }).
// PANE_<id>_* env vars set the same pane and are overridden by the file. Pane count is the larger
// of the two, at least MIN_PANES.
function loadPaneConfigs() {
  let filePanes = [];
  if (fs.existsSync(CONFIG_FILE)) {
    filePanes = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).panes ?? [];
    if (!Array.isArray(filePanes)) {
      throw new Error(`${CONFIG_FILE}: "panes" must be an array of endpoints (see config.example.json)`);
    }
    if (filePanes.length > PANE_IDS.length) {
      console.warn(`config.json lists ${filePanes.length} panes; only the first ${PANE_IDS.length} are used`);
    }
    filePanes.forEach((p, i) => {
      for (const key of Object.keys(p)) {
        if (RENAMED[key]) throw new Error(`${CONFIG_FILE}: panes[${i}].${key} is no longer supported; use ${RENAMED[key]}`);
        if (!PANE_FIELDS.includes(key)) throw new Error(`${CONFIG_FILE}: panes[${i}].${key} is not a pane field (${PANE_FIELDS.join(', ')})`);
      }
    });
  }
  const envCount = PANE_IDS.findLastIndex((id) => Object.keys(process.env).some((k) => k.startsWith(`PANE_${id}_`))) + 1;
  const count = Math.min(PANE_IDS.length, Math.max(MIN_PANES, filePanes.length, envCount));
  return Object.fromEntries(
    PANE_IDS.slice(0, count).map((id, i) => {
      const pane = Object.assign(defaultPane(id), filePanes[i] ?? {});
      try {
        checkEndpoint(pane.endpoint);
      } catch (err) {
        throw new Error(`pane ${id}: ${err.message}`);
      }
      return [id, pane];
    }),
  );
}

const config = loadPaneConfigs();

const publicPane = ({ api_key, ...rest }) => ({
  ...rest,
  format: endpointFormat(rest.endpoint),
  has_api_key: Boolean(api_key),
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('request body too large');
  }
  return data ? JSON.parse(data) : {};
}

// mock://random: random characters, mostly legal actions with some noise to exercise illegal output.
function mockCompletion(actions) {
  if (Math.random() < 0.1) return Math.random() < 0.5 ? 'x' : ' ';
  return actions[Math.floor(Math.random() * actions.length)];
}

async function postJson(pane, url, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (pane.api_key) headers.Authorization = `Bearer ${pane.api_key}`;
  const started = performance.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const latency_ms = Math.round(performance.now() - started);
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`upstream HTTP ${resp.status}: ${text.slice(0, 500)}`);
    err.status = resp.status;
    if (isDecisionsOnlyError(resp.status, text)) {
      err.message += ' (this is a decisions model: set the endpoint to https://openrouter.ai/api/alpha/decisions)';
    }
    throw err;
  }
  return { body: JSON.parse(text), latency_ms };
}

async function callLLM(pane, gameId, userMessage, question) {
  const engine = engines[gameId];
  const format = endpointFormat(pane.endpoint);
  if (format === 'mock') {
    return { raw: mockCompletion(engine.ACTIONS), latency_ms: 0, finish_reason: 'length' };
  }
  const args = { model: pane.model, systemPrompt: engine.SYSTEM_PROMPT, userMessage, temperature: pane.temperature };
  if (format === 'decisions') {
    const { body, latency_ms } = await postJson(pane, pane.endpoint, buildDecisionsRequest({ ...args, ...question }));
    const out = parseDecisionsResponse(body);
    // Options vary per step in some games, so log the ones sent.
    return { ...out, decision: { ...out.decision, criteria: question.criteria }, latency_ms };
  }
  if (format === 'completions') {
    const { body, latency_ms } = await postJson(pane, pane.endpoint, buildCompletionsRequest(args));
    return { ...parseCompletionsResponse(body), latency_ms };
  }
  const request = buildChatRequest({ ...args, endpoint: pane.endpoint });
  return requestChatAction(() => postJson(pane, pane.endpoint, request), engine.parseAction);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');

    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, {
        games: Object.fromEntries(
          Object.entries(engines).map(([id, e]) => [id, { system_prompt: e.SYSTEM_PROMPT, actions: e.ACTIONS }]),
        ),
        panes: Object.entries(config).map(([id, pane]) => ({ id, ...publicPane(pane) })),
      });
    }

    const cfgMatch = pathname.match(/^\/api\/config\/([A-Z])$/);
    if (req.method === 'POST' && cfgMatch && Object.hasOwn(config, cfgMatch[1])) {
      const body = await readJson(req);
      const pane = config[cfgMatch[1]];
      if (typeof body.endpoint === 'string' && body.endpoint.trim()) pane.endpoint = checkEndpoint(body.endpoint.trim());
      if (typeof body.model === 'string' && body.model.trim()) pane.model = body.model.trim();
      if (body.temperature !== undefined && body.temperature !== '') {
        const t = Number(body.temperature);
        if (!Number.isFinite(t)) return sendJson(res, 400, { error: 'temperature must be a number' });
        pane.temperature = t;
      }
      // Empty api_key keeps the old key; clear_api_key removes it.
      if (typeof body.api_key === 'string' && body.api_key) pane.api_key = body.api_key;
      if (body.clear_api_key) pane.api_key = '';
      return sendJson(res, 200, { id: cfgMatch[1], ...publicPane(pane) });
    }

    if (req.method === 'POST' && pathname === '/api/step') {
      const body = await readJson(req);
      const pane = Object.hasOwn(config, body.pane) ? config[body.pane] : undefined;
      if (!pane) return sendJson(res, 400, { error: 'unknown pane' });
      if (!Object.hasOwn(engines, body.game)) return sendJson(res, 400, { error: 'unknown game' });
      if (typeof body.user_message !== 'string') return sendJson(res, 400, { error: 'user_message required' });
      // Throws (-> 400) when the question names an unknown action.
      const question = decisionQuestion(body.decision_question, engines[body.game].ACTIONS, criteria[body.game]);
      try {
        return sendJson(res, 200, await callLLM(pane, body.game, body.user_message, question));
      } catch (err) {
        return sendJson(res, 502, {
          error: String(err.message || err),
          upstream_status: err.status ?? null,
          // Unexpected output stops the match in the browser; not retried as an API error.
          ...(err.code === 'unexpected_output' && { code: err.code, rejected: err.rejected }),
        });
      }
    }

    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 400, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`System-1 LLM arena (${Object.keys(engines).join(', ')}) on http://${HOST}:${PORT}`);
});
