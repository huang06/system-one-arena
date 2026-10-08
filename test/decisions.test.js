import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES } from '../public/games/registry.js';
import {
  DECISION_INSTRUCTIONS,
  actionCriteria,
  buildDecisionsRequest,
  decisionQuestion,
  isDecisionsOnlyError,
  parseDecisionsResponse,
} from '../decisions.js';

test('recognizes the chat/completions rejection of a decisions-only model', () => {
  const body = JSON.stringify({
    error: {
      message: 'inception/mercury-decide:free is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead.',
      code: 400,
    },
  });
  assert.equal(isDecisionsOnlyError(400, body), true);
  assert.equal(isDecisionsOnlyError(502, body), false);
  assert.equal(isDecisionsOnlyError(400, '{"error":{"message":"invalid model","code":400}}'), false);
});

test('every game prompt describes every action', async () => {
  for (const { id } of GAMES) {
    const engine = await import(`../public/games/${id}/engine.js`);
    const criteria = actionCriteria(engine.SYSTEM_PROMPT, engine.ACTIONS);
    assert.deepEqual(Object.keys(criteria), [...engine.ACTIONS], id);
    for (const label of Object.values(criteria)) assert.ok(label.length > 0, id);
  }
  const tetris = await import('../public/games/tetris/engine.js');
  assert.equal(actionCriteria(tetris.SYSTEM_PROMPT, tetris.ACTIONS).S, 'hard drop (instantly place the piece at the ghost position)');
  assert.throws(() => actionCriteria('Actions:\nL = left\n', 'LR'), /R/);
});

test('request and response map onto one choice question', () => {
  const req = buildDecisionsRequest({
    model: 'typesafe/jev-1.13',
    systemPrompt: 'rules',
    userMessage: 'board',
    criteria: { L: 'left', R: 'right' },
  });
  assert.deepEqual(req.state, { rules: 'rules', observation: 'board' });
  assert.equal(req.questions.action.type, 'choice');
  assert.deepEqual(req.questions.action.criteria, { L: 'left', R: 'right' });
  assert.equal('temperature' in req, false);

  const out = parseDecisionsResponse({
    model: 'typesafe/jev-1.13-20260917',
    answers: { action: { type: 'choice', choice: 'R', confidence: 0.6, probabilities: { L: 0.2, R: 0.8 } } },
    usage: { input_tokens: 100, output_tokens: 10, cost: 0.0000042 },
  });
  assert.equal(out.raw, 'R');
  assert.deepEqual(out.decision, {
    confidence: 0.6,
    probabilities: { L: 0.2, R: 0.8 },
    model: 'typesafe/jev-1.13-20260917',
    cost: 0.0000042,
  });
  assert.equal(parseDecisionsResponse({ answers: {} }).raw, '');
});

test('a missing question is the generic one; a supplied one is checked against the actions', () => {
  const generic = { L: 'left', R: 'right' };
  assert.deepEqual(decisionQuestion(undefined, 'LR', generic), { instructions: DECISION_INSTRUCTIONS, criteria: generic });
  assert.deepEqual(decisionQuestion({ instructions: 'q?', criteria: { R: 'go right' } }, 'LR', generic), {
    instructions: 'q?',
    criteria: { R: 'go right' },
  });
  assert.throws(() => decisionQuestion({ criteria: { X: 'nope' } }, 'LR', generic), /unknown action "X"/);
  assert.throws(() => decisionQuestion({ criteria: {} }, 'LR', generic), /at least one/);
  assert.throws(() => decisionQuestion({ criteria: { L: 3 } }, 'LR', generic), /must be a string/);
});

test('every game asks a valid question for its states and leaves the game untouched', async () => {
  for (const { id } of GAMES) {
    const engine = await import(`../public/games/${id}/engine.js`);
    const { default: adapter } = await import(`../public/games/${id}/game.js`);
    assert.equal(adapter.decisionQuestion, engine.decisionQuestion, id);
    const settings = Object.fromEntries(adapter.settings.map((s) => [s.id, s.default]));
    const game = adapter.createGame({ seed: 7, settings });
    const twin = adapter.createGame({ seed: 7, settings });
    for (let i = 0; i < 40 && !game.over; i++) {
      const q = decisionQuestion(adapter.decisionQuestion(game), engine.ACTIONS, {});
      assert.ok(Object.keys(q.criteria).length >= 3, id);
      const action = engine.ACTIONS[i % engine.ACTIONS.length];
      adapter.step(game, action);
      adapter.step(twin, action);
      assert.equal(adapter.prompt(game, settings), adapter.prompt(twin, settings), `${id} step ${i}`);
    }
  }
});
