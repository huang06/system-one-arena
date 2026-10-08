// Generic arena: one pane per configured bot (up to 4); joined panes (at least 2) play the same
// game with the same seed, one LLM call per step. Game specifics come from games/<id>/game.js:
//
//   systemPrompt              must equal the engine's SYSTEM_PROMPT (the server sends that one)
//   parseAction(raw)          -> action, or null for illegal output (counted, no-op)
//   settings                  [{ id, label, type: 'number' | 'checkbox', default, min? }]
//   fixedSettings             optional; copied into the exported settings
//   createGame({ seed, settings }) -> game; reads game.over / game.endReason / game.score
//   prompt(game, settings)    -> user message for the current state
//   snapshot(game)            -> fields logged before the step (at least what the LLM saw)
//   step(game, action)        -> fields logged after the step (action may be null)
//   stats                     [{ key, label, value(game) }] shown in each pane
//   result(game)              -> per-game result, must include score
//   compare?(a, b)            -> > 0 if a beats b (default: higher score); used for ranking
//   endLabel(game)            -> pane status once game.over
//   endReasons                { [endReason]: label } for the summary
//   summary                   [{ key, label, percent? }] averaged over result[key]
//   columns                   [{ key, label }] per-pane columns in the games table
//   decisionNote?(entry)      -> short text for a decision-log row (default: entry.result)
//   decisionQuestion?(game)   -> Decisions API { instructions, criteria }: options for this state
//                                (keyed by action letter) with their outcomes
//   createView(el)            -> { render(game) }
import { GAMES } from './games/registry.js';

const MIN_PANES = 2; // minimum joined panes for a match
const MAX_ATTEMPTS = 3;
const $ = (id) => document.getElementById(id);

const meta = GAMES.find((g) => g.id === new URLSearchParams(location.search).get('game'));
if (!meta) {
  location.replace('./');
  throw new Error('unknown game');
}
const { default: adapter } = await import(`./games/${meta.id}/game.js`);

const ui = {}; // pane id -> DOM refs
let allPaneIds = []; // all server panes, in config order
let paneConfigs = {}; // pane id -> public config (no api key)
let gameActions = ''; // action letters, in prompt order
let runId = 0;
let running = false;
let paused = false;
let resumeWaiters = [];
let record = null; // exportable log of the current run
let panes = {}; // pane id -> live state for the current game
let paneIds = []; // joined panes (all by default)

// ---------- setup ----------

function setupPage() {
  document.title = `${meta.title} · System-1 LLM Arena`;
  document.body.dataset.game = meta.id;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `games/${meta.id}/style.css`;
  document.head.appendChild(css);
  $('gameTitle').textContent = `${meta.title} ${meta.subtitle}`;
  $('systemPrompt').textContent = adapter.systemPrompt;

  for (const s of adapter.settings) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = `setting-${s.id}`;
    input.type = s.type;
    if (s.type === 'checkbox') {
      label.className = 'check';
      input.checked = Boolean(s.default);
      label.append(input, ` ${s.label}`);
    } else {
      input.value = s.default;
      if (s.min !== undefined) input.min = s.min;
      if (s.max !== undefined) input.max = s.max;
      label.append(`${s.label} `, input);
    }
    input.addEventListener('change', () => !running && reset());
    $('startBtn').before(label);
  }
}

// Marks joined panes and matches the games table columns.
function showPanes() {
  for (const id of allPaneIds) {
    const joined = paneIds.includes(id);
    ui[id].root.classList.toggle('out', !joined);
    ui[id].join.checked = joined;
    if (!joined) ui[id].state.textContent = 'Not joined';
  }
  updateJoinToggles();
  const tr = $('gamesTable').tHead.rows[0];
  tr.replaceChildren();
  const th = (text) => tr.appendChild(Object.assign(document.createElement('th'), { textContent: text }));
  th('#');
  th('Seed');
  for (const id of paneIds) for (const c of adapter.columns) th(`${id} ${c.label}`);
  th('Winner');
}

// Locked during a run; the last MIN_PANES joined panes cannot leave.
function updateJoinToggles() {
  for (const id of allPaneIds) {
    ui[id].join.disabled = running || (ui[id].join.checked && paneIds.length <= MIN_PANES);
  }
}

function setJoined(id, joined) {
  if (running) return;
  paneIds = allPaneIds.filter((p) => (p === id ? joined : paneIds.includes(p)));
  showPanes();
  reset();
}

function buildPanes() {
  const tpl = $('paneTemplate');
  $('panes').dataset.count = allPaneIds.length;
  for (const id of allPaneIds) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const dl = node.querySelector('.stats');
    const statDefs = [
      ...adapter.stats.map((s) => [s.key, s.label]),
      ['_steps', 'Steps'],
      ['_latency', 'Avg latency'],
      ['_illegal', 'Illegal output'],
      ['_retries', 'Output retries'],
      ['_errors', 'API errors'],
      ['_last', 'Last reply'],
    ];
    const stats = {};
    for (const [key, label] of statDefs) {
      dl.appendChild(Object.assign(document.createElement('dt'), { textContent: label }));
      stats[key] = dl.appendChild(document.createElement('dd'));
    }
    stats._last.className = 'mono';
    ui[id] = {
      root: node,
      view: adapter.createView(node.querySelector('.view')),
      stats,
      form: node.querySelector('form'),
      model: node.querySelector('.model-name'),
      state: node.querySelector('.pane-state'),
      join: node.querySelector('.join-toggle'),
      error: node.querySelector('.pane-error'),
      msg: node.querySelector('.config-msg'),
      prompt: node.querySelector('.last-prompt'),
      decisions: {
        count: node.querySelector('.decision-count'),
        mix: node.querySelector('.decision-mix'),
        list: node.querySelector('.decision-list'),
      },
    };
    node.querySelector('.pane-id').textContent = id;
    ui[id].form.addEventListener('submit', (e) => {
      e.preventDefault();
      saveConfig(id);
    });
    ui[id].join.addEventListener('change', (e) => setJoined(id, e.target.checked));
    $('panes').appendChild(node);
  }
  showPanes();
}

async function loadConfig() {
  const resp = await fetch('/api/config');
  const body = await resp.json();
  const serverGame = body.games[meta.id];
  if (!serverGame) throw new Error(`server has not loaded game "${meta.id}"`);
  if (serverGame.system_prompt !== adapter.systemPrompt) console.warn('server and client system prompts differ');
  gameActions = serverGame.actions;
  allPaneIds = body.panes.map((p) => p.id);
  paneIds = [...allPaneIds];
  paneConfigs = Object.fromEntries(body.panes.map((p) => [p.id, p]));
}

function fillConfigForm(id) {
  const cfg = paneConfigs[id];
  const f = ui[id].form.elements;
  f.endpoint.value = cfg.endpoint;
  f.model.value = cfg.model;
  f.temperature.value = cfg.temperature;
  f.api_key.value = '';
  f.api_key.placeholder = cfg.has_api_key ? '(set; leave empty to keep)' : '(not set)';
  f.clear_api_key.checked = false;
  // Show the format unless plain chat completions.
  ui[id].model.textContent = cfg.format === 'chat' || cfg.format === 'mock' ? cfg.model : `${cfg.model} (${cfg.format})`;
}

async function saveConfig(id) {
  const f = ui[id].form.elements;
  const resp = await fetch(`/api/config/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: f.endpoint.value,
      api_key: f.api_key.value,
      model: f.model.value,
      temperature: f.temperature.value,
      clear_api_key: f.clear_api_key.checked,
    }),
  });
  const body = await resp.json();
  if (!resp.ok) {
    ui[id].msg.textContent = `Error: ${body.error}`;
    return;
  }
  paneConfigs[id] = body;
  fillConfigForm(id);
  ui[id].msg.textContent = 'Saved';
  setTimeout(() => (ui[id].msg.textContent = ''), 2000);
}

function readSettings() {
  const int = (el, min, max = Infinity) => Math.min(max, Math.max(min, Math.floor(Number(el.value) || 0)));
  const settings = {
    seed: Math.floor(Number($('seed').value) || 0),
    games: int($('games'), 1),
    step_delay_ms: int($('delay'), 0),
    ...adapter.fixedSettings,
  };
  for (const s of adapter.settings) {
    const el = $(`setting-${s.id}`);
    settings[s.id] = s.type === 'checkbox' ? el.checked : int(el, s.min ?? -Infinity, s.max);
  }
  return settings;
}

// ---------- pane state & rendering ----------

function newPaneState(id, seed, settings) {
  return {
    id,
    game: adapter.createGame({ seed, settings }),
    log: [],
    actionCounts: {},
    confidenceSum: 0,
    confidenceN: 0,
    illegal: 0,
    retries: 0, // chat replies re-asked by the server
    errors: 0,
    latencySum: 0,
    lastRaw: null,
    lastPrompt: null,
    failed: null, // API error once the pane gives up on this game
    aborted: false, // this pane's unexpected output stopped the match
  };
}

// New pane states for one game; clears the decision logs.
function startPanes(seed, settings) {
  for (const id of paneIds) ui[id].decisions.list.replaceChildren();
  panes = Object.fromEntries(paneIds.map((id) => [id, newPaneState(id, seed, settings)]));
}

function render(p) {
  const { game } = p;
  const u = ui[p.id];
  u.view.render(game);
  const s = u.stats;
  for (const st of adapter.stats) s[st.key].textContent = st.value(game);
  s._steps.textContent = p.log.length;
  s._latency.textContent = p.log.length ? `${Math.round(p.latencySum / p.log.length)} ms` : '–';
  s._illegal.textContent = p.illegal;
  s._retries.textContent = p.retries;
  s._errors.textContent = p.errors;
  s._last.textContent = p.lastRaw === null ? '–' : JSON.stringify(p.lastRaw);
  u.prompt.textContent = p.lastPrompt ?? '(nothing sent yet)';
  renderDecisionMix(p);
  u.state.textContent = p.aborted
    ? 'Unexpected output'
    : p.failed
      ? 'API failed'
      : game.over
        ? adapter.endLabel(game)
        : running ? (paused ? 'Paused' : 'Running') : record?.aborted ? 'Aborted' : 'Ready';
  scheduleScoreboard();
}

// ---------- decision log ----------

const pct = (v) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(1)}%`);

function el(parent, tag, className, text) {
  const node = parent.appendChild(document.createElement(tag));
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderDecisionMix(p) {
  const d = ui[p.id].decisions;
  const n = p.log.length;
  d.count.textContent = n ? `(${n} steps)` : '';
  if (!n) {
    d.mix.textContent = 'No decisions yet';
    return;
  }
  const parts = [...gameActions].map((a) => `${a} ${p.actionCounts[a] ?? 0} (${pct((p.actionCounts[a] ?? 0) / n)})`);
  if (p.illegal) parts.push(`illegal ${p.illegal} (${pct(p.illegal / n)})`);
  if (p.confidenceN) parts.push(`avg confidence ${pct(p.confidenceSum / p.confidenceN)}`);
  d.mix.textContent = parts.join(' · ');
}

// One collapsible row per step, newest first. The body is built on first open.
function addDecisionRow(p, entry, userMessage) {
  const row = document.createElement('details');
  row.className = entry.legal ? 'decision' : 'decision illegal';
  const head = el(row, 'summary');
  el(head, 'span', 'd-i', `#${entry.i}`);
  el(head, 'span', 'd-act', entry.legal ? entry.action : '✕');
  if (entry.raw !== entry.action) el(head, 'span', 'd-raw mono', JSON.stringify(entry.raw));
  if (entry.retries) el(head, 'span', 'd-retry', `retries ${entry.retries}`);
  el(head, 'span', 'd-note', String(adapter.decisionNote?.(entry) ?? entry.result ?? ''));

  const probs = entry.decision?.probabilities;
  if (probs) {
    const bars = el(head, 'span', 'd-probs');
    for (const a of new Set([...gameActions, ...Object.keys(probs)])) {
      const v = Number(probs[a] ?? 0);
      const bar = el(bars, 'span', a === entry.action ? 'p chosen' : 'p', a);
      bar.style.setProperty('--p', v);
      bar.title = `${a} ${pct(v)}`;
    }
  }
  const conf = entry.decision?.confidence;
  el(head, 'span', 'd-conf', conf === null || conf === undefined ? '' : pct(conf));
  el(head, 'span', 'd-lat', `${entry.latency_ms} ms`);

  row.addEventListener('toggle', () => {
    if (!row.open || row.dataset.filled) return;
    row.dataset.filled = '1';
    const body = el(row, 'div', 'd-body');
    const facts = [`raw ${JSON.stringify(entry.raw)}`, `finish_reason ${entry.finish_reason ?? 'null'}`];
    if (entry.decision) {
      facts.push(`model ${entry.decision.model ?? '–'}`, `cost ${entry.decision.cost ?? '–'} USD`);
    }
    el(body, 'div', 'd-facts mono', facts.join(' · '));
    if (entry.rejected) el(body, 'div', 'd-facts mono', `rejected ${entry.rejected.map((r) => JSON.stringify(r)).join(', ')}`);
    if (probs) {
      const sorted = Object.entries(probs).sort((x, y) => y[1] - x[1]);
      el(body, 'div', 'd-facts mono', sorted.map(([a, v]) => `${a} ${pct(v)}`).join('  '));
    }
    const criteria = entry.decision?.criteria;
    if (criteria) el(body, 'pre', 'mono', Object.entries(criteria).map(([a, c]) => `${a} = ${c}`).join('\n'));
    el(body, 'pre', 'mono', userMessage);
  });
  ui[p.id].decisions.list.prepend(row);
}

function setStatus(text) {
  $('status').textContent = text;
}

function setRunningUI() {
  $('startBtn').disabled = running;
  $('pauseBtn').disabled = !running;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  $('exportBtn').disabled = !record;
  for (const el of $('controls').querySelectorAll('input')) el.disabled = running;
  for (const id of allPaneIds) {
    for (const el of ui[id].form.elements) el.disabled = running;
  }
  updateJoinToggles();
  for (const p of Object.values(panes)) render(p);
}

// ---------- run loop ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitWhilePaused() {
  if (!paused) return Promise.resolve();
  return new Promise((r) => resumeWaiters.push(r));
}

function setPaused(value) {
  paused = value;
  if (!paused) {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    waiters.forEach((r) => r());
  }
  setRunningUI();
}

// A chat pane still gave no action after CHAT_OUTPUT_RETRIES re-asks: stop the match. Every loop
// sees the new runId and returns; the unfinished game is exported as in_progress.
function abortMatch(p, body) {
  p.failed = body.error;
  p.aborted = true;
  record.aborted = {
    pane: p.id,
    model: record.panes[p.id].model,
    game: record.games.length + 1,
    step: p.log.length + 1,
    error: body.error,
    rejected: body.rejected ?? [],
    at: new Date().toISOString(),
  };
  ui[p.id].error.textContent = `Unexpected output: ${body.error}\nMatch aborted.`;
  setStatus(`Match aborted: ${p.id} (${record.panes[p.id].model}) kept giving unexpected output at game ${record.aborted.game}, step ${record.aborted.step}`);
  runId++;
  running = false;
  setPaused(false); // lets paused loops exit
}

// Proxy response, retrying transient failures. After MAX_ATTEMPTS the pane gives up on this game
// (sets p.failed, returns null); others play on. Unexpected output aborts the match instead.
async function requestAction(p, userMessage, myRun) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Only the Decisions API uses the per-step question.
      const question = paneConfigs[p.id]?.format === 'decisions' ? adapter.decisionQuestion?.(p.game) : undefined;
      const resp = await fetch('/api/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: meta.id, pane: p.id, user_message: userMessage, decision_question: question }),
      });
      const body = await resp.json();
      if (resp.ok) {
        ui[p.id].error.textContent = '';
        return body;
      }
      if (body.code === 'unexpected_output') {
        if (myRun === runId) abortMatch(p, body);
        return null;
      }
      lastError = body.error || `HTTP ${resp.status}`;
    } catch (err) {
      lastError = String(err);
    }
    p.errors += 1;
    render(p);
    if (myRun !== runId) return null;
    await sleep(500 * 2 ** (attempt - 1));
  }
  p.failed = lastError;
  ui[p.id].error.textContent = `API failed after ${MAX_ATTEMPTS} attempts: ${lastError}\nThis pane stopped for this game; the others play on.`;
  render(p);
  return null;
}

async function runPane(p, settings, myRun) {
  const { game } = p;
  while (!game.over) {
    await waitWhilePaused();
    if (myRun !== runId) return;
    const userMessage = adapter.prompt(game, settings);
    const snap = adapter.snapshot(game);
    const t = new Date().toISOString();
    const resp = await requestAction(p, userMessage, myRun);
    if (myRun !== runId || !resp) return;

    const action = adapter.parseAction(resp.raw);
    const ev = adapter.step(game, action);
    if (action === null) p.illegal += 1;
    p.retries += resp.retries ?? 0;
    p.latencySum += resp.latency_ms;
    p.lastRaw = resp.raw;
    p.lastPrompt = userMessage;
    const entry = {
      i: p.log.length + 1,
      t,
      ...snap,
      raw: resp.raw,
      finish_reason: resp.finish_reason,
      latency_ms: resp.latency_ms,
      ...(resp.decision && { decision: resp.decision }),
      ...(resp.retries !== undefined && { retries: resp.retries }),
      ...(resp.rejected && { rejected: resp.rejected }),
      legal: action !== null,
      action,
      ...ev,
      score: game.score,
    };
    p.log.push(entry);
    if (action !== null) p.actionCounts[action] = (p.actionCounts[action] ?? 0) + 1;
    if (typeof resp.decision?.confidence === 'number') {
      p.confidenceSum += resp.decision.confidence;
      p.confidenceN += 1;
    }
    addDecisionRow(p, entry, userMessage);
    render(p);
    if (settings.step_delay_ms) await sleep(settings.step_delay_ms);
  }
}

function paneResult(p) {
  return {
    ...adapter.result(p.game),
    steps: p.log.length,
    illegal: p.illegal,
    output_retries: p.retries,
    api_errors: p.errors,
    avg_latency_ms: p.log.length ? p.latencySum / p.log.length : null,
    end_reason: p.aborted ? 'unexpected_output' : p.failed ? 'api_error' : p.game.endReason,
    ...(p.failed && { api_error: p.failed }),
  };
}

// Competition ranking (1 + panes strictly better; ties share a rank). Winner is the sole rank 1,
// else 'draw'.
function rankResults(results) {
  const cmp = adapter.compare ?? ((a, b) => a.score - b.score);
  const ids = Object.keys(results);
  const ranks = Object.fromEntries(
    ids.map((id) => [id, 1 + ids.filter((o) => cmp(results[o], results[id]) > 0).length]),
  );
  const first = ids.filter((id) => ranks[id] === 1);
  return { winner: first.length === 1 ? first[0] : 'draw', ranks };
}

async function startRun() {
  const settings = readSettings();
  const myRun = ++runId;
  running = true;
  paused = false;
  record = {
    tool: 'system1-llm-arena',
    version: 2,
    game: meta.id,
    started_at: new Date().toISOString(),
    settings,
    system_prompt: adapter.systemPrompt,
    panes: Object.fromEntries(
      paneIds.map((id) => {
        const { endpoint, model, temperature, format } = paneConfigs[id];
        return [id, { endpoint, model, temperature, format }];
      }),
    ),
    games: [],
  };
  $('gamesTable').tBodies[0].innerHTML = '';
  renderScoreboard();
  setRunningUI();

  for (let g = 0; g < settings.games; g++) {
    const seed = settings.seed + g;
    startPanes(seed, settings);
    Object.values(panes).forEach(render);
    setStatus(`Game ${g + 1}/${settings.games} running (seed ${seed})`);
    await Promise.all(Object.values(panes).map((p) => runPane(p, settings, myRun)));
    if (myRun !== runId) return;

    const results = Object.fromEntries(paneIds.map((id) => [id, paneResult(panes[id])]));
    record.games.push({
      index: g + 1,
      seed,
      ...rankResults(results),
      results,
      logs: Object.fromEntries(paneIds.map((id) => [id, panes[id].log])),
    });
    addGameRow(record.games.at(-1));
    renderScoreboard();
  }
  running = false;
  record.finished_at = new Date().toISOString();
  setStatus(`Finished ${settings.games} game${settings.games === 1 ? '' : 's'}`);
  setRunningUI();
}

function reset() {
  runId++;
  running = false;
  setPaused(false);
  record = null;
  const settings = readSettings();
  startPanes(settings.seed, settings);
  for (const id of allPaneIds) ui[id].error.textContent = '';
  $('gamesTable').tBodies[0].innerHTML = '';
  renderScoreboard();
  setStatus('Ready');
  setRunningUI();
}

// ---------- summary & export ----------

function computeSummary() {
  const games = record?.games ?? [];
  const n = games.length;
  const draws = games.filter((g) => g.winner === 'draw').length;
  const perPane = Object.fromEntries(
    summaryPaneIds().map((id) => {
      const rs = games.map((g) => g.results[id]);
      const avg = (key) => (n ? rs.reduce((s, r) => s + r[key], 0) / n : null);
      const steps = rs.reduce((s, r) => s + r.steps, 0);
      const wins = games.filter((g) => g.winner === id).length;
      const endReasons = {};
      for (const r of rs) endReasons[r.end_reason] = (endReasons[r.end_reason] ?? 0) + 1;
      return [id, {
        model: record?.panes[id].model ?? paneConfigs[id]?.model,
        wins,
        win_rate: n ? wins / n : null,
        avg_rank: n ? games.reduce((s, g) => s + g.ranks[id], 0) / n : null,
        ...Object.fromEntries(adapter.summary.map((s) => [`avg_${s.key}`, avg(s.key)])),
        avg_latency_ms: steps ? rs.reduce((s, r) => s + (r.avg_latency_ms ?? 0) * r.steps, 0) / steps : null,
        illegal_rate: steps ? rs.reduce((s, r) => s + r.illegal, 0) / steps : null,
        end_reasons: endReasons,
      }];
    }),
  );
  return { games: n, draws, panes: perPane };
}

// Panes of the current run, or the joined ones before a run.
const summaryPaneIds = () => (record ? Object.keys(record.panes) : paneIds);

// Scoreboard: live rank and score per pane plus run totals, sorted by live rank.
let scoreboardQueued = false;
function scheduleScoreboard() {
  if (scoreboardQueued) return;
  scoreboardQueued = true;
  requestAnimationFrame(() => {
    scoreboardQueued = false;
    renderScoreboard();
  });
}

function renderScoreboard() {
  const s = computeSummary();
  const fmt = (v, d = 1) => (v === null || v === undefined ? '–' : v.toFixed(d));
  const ids = summaryPaneIds().filter((id) => panes[id]);
  const live = Object.fromEntries(ids.map((id) => [id, paneResult(panes[id])]));
  // No ranks before the first step.
  const { ranks } = ids.some((id) => panes[id].log.length) ? rankResults(live) : { ranks: {} };
  // Best rank first; ties keep pane order.
  ids.sort((a, b) => (ranks[a] ?? 0) - (ranks[b] ?? 0));
  $('scoreCards').innerHTML = ids.map((id) => {
    const p = panes[id];
    const t = s.panes[id];
    const n = p.log.length;
    const rank = ranks[id];
    const state = escapeHtml(ui[id].state.textContent);
    const now = [
      `steps ${n}`,
      `latency ${n ? Math.round(p.latencySum / n) : '–'} ms`,
      `illegal ${n ? pct(p.illegal / n) : '–'}`,
      ...(p.confidenceN ? [`confidence ${pct(p.confidenceSum / p.confidenceN)}`] : []),
    ].join(' · ');
    let total = '';
    if (s.games) {
      const avgs = adapter.summary
        .map((x) => `${x.label} ${x.percent ? pct(t[`avg_${x.key}`]) : fmt(t[`avg_${x.key}`])}`)
        .join(' · ');
      const ends = Object.entries(t.end_reasons)
        .map(([k, v]) => `${escapeHtml(adapter.endReasons[k] ?? (k === 'api_error' ? 'API failed' : k))} ${v}`)
        .join(' · ');
      total = `<div class="sc-total">Total ${s.games} games · ${t.wins} wins (${pct(t.win_rate)}, ${s.draws} draws)${ids.length > 2 ? ` · avg rank ${fmt(t.avg_rank, 2)}` : ''}</div>
        <div class="sc-total">${avgs} · avg latency ${fmt(t.avg_latency_ms, 0)} ms · illegal ${pct(t.illegal_rate)}${ends ? ` · ends: ${ends}` : ''}</div>`;
    }
    return `<div class="score-card${rank === 1 ? ' lead' : ''}${p.failed ? ' failed' : ''}">
      <div class="sc-head"><span class="sc-rank">${rank ? `#${rank}` : ''}</span><b class="pane-id">${id}</b>
        <span class="sc-model">${escapeHtml(t.model ?? '')}</span><span class="sc-state">${state}</span></div>
      <div class="sc-now"><span class="sc-label">This game</span><span class="sc-score">${p.game.score}</span><span>${now}</span></div>
      ${total}</div>`;
  }).join('');
  $('gamesCount').textContent = s.games ? `(${s.games})` : '';
}

function addGameRow(g) {
  const tr = document.createElement('tr');
  const cells = [g.index, g.seed];
  for (const id of Object.keys(g.results)) for (const c of adapter.columns) cells.push(g.results[id][c.key]);
  cells.push(g.winner === 'draw' ? 'Draw' : g.winner);
  for (const v of cells) tr.appendChild(document.createElement('td')).textContent = v;
  $('gamesTable').tBodies[0].appendChild(tr);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function exportJson() {
  if (!record) return;
  const data = { ...record, exported_at: new Date().toISOString(), summary: computeSummary() };
  if (running || record.aborted) {
    // Include the unfinished game of a paused or aborted run.
    data.in_progress = Object.fromEntries(
      Object.values(panes).map((p) => [p.id, { results: paneResult(p), log: p.log }]),
    );
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${meta.id}-arena-${record.started_at.replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- wiring ----------

setupPage();
$('startBtn').addEventListener('click', startRun);
$('pauseBtn').addEventListener('click', () => {
  if (!paused) setStatus(`${$('status').textContent} (pausing after in-flight requests)`);
  else setStatus($('status').textContent.replace(/ \(pausing.*\)$/, ''));
  setPaused(!paused);
});
$('resetBtn').addEventListener('click', reset);
$('exportBtn').addEventListener('click', exportJson);
$('seed').addEventListener('change', () => !running && reset());
loadConfig()
  .then(() => {
    buildPanes();
    for (const id of allPaneIds) fillConfigForm(id);
    reset();
  })
  .catch((err) => setStatus(`Failed to load config: ${err.message ?? err}`));
