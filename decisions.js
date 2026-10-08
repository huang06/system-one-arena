// OpenRouter Decisions API (POST https://openrouter.ai/api/alpha/decisions) for System One decision
// models such as TypeSafe Jev, which lack /chat/completions. Each step is one Choice question over
// the game's action letters; the answer becomes `raw`.
// Docs: https://openrouter.ai/docs/guides/community/jev

export const DECISION_INSTRUCTIONS =
  'Following the rules, which action should the player take next in the current observation?';

// OpenRouter's HTTP 400 for a decision model on chat/completions: "<model> is a decisions model
// and cannot be used with the chat/completions endpoint".
export const isDecisionsOnlyError = (status, text) => status === 400 && /is a decisions model/i.test(text ?? '');

// Choice criteria from the system prompt's "Actions:" block ("L = move left"), so both APIs agree.
export function actionCriteria(systemPrompt, actions) {
  const block = systemPrompt.match(/^Actions:\n((?:.+\n?)+)/m)?.[1] ?? '';
  const labels = Object.fromEntries([...block.matchAll(/^(\S) = (.+)$/gm)].map((m) => [m[1], m[2].trim()]));
  const missing = [...actions].filter((a) => !labels[a]);
  if (missing.length) throw new Error(`system prompt has no "X = ..." line for action(s) ${missing.join(' ')}`);
  return Object.fromEntries([...actions].map((a) => [a, labels[a]]));
}

// One step's Choice question: the adapter's decisionQuestion(game) -> { instructions, criteria }
// sent by the browser, or else the generic question over every action.
export function decisionQuestion(question, actions, criteria) {
  if (question === undefined || question === null) return { instructions: DECISION_INSTRUCTIONS, criteria };
  const { instructions = DECISION_INSTRUCTIONS, criteria: options } = question;
  if (typeof instructions !== 'string' || !instructions) throw new Error('decision_question.instructions must be a string');
  const entries = Object.entries(options ?? {});
  if (!entries.length) throw new Error('decision_question.criteria must list at least one action');
  for (const [a, text] of entries) {
    if (a.length !== 1 || !actions.includes(a)) throw new Error(`decision_question.criteria: unknown action ${JSON.stringify(a)}`);
    if (typeof text !== 'string' || !text) throw new Error(`decision_question.criteria.${a} must be a string`);
  }
  return { instructions, criteria: Object.fromEntries(entries) };
}

export function buildDecisionsRequest({ model, systemPrompt, userMessage, instructions = DECISION_INSTRUCTIONS, criteria }) {
  return {
    model,
    state: { rules: systemPrompt, observation: userMessage },
    questions: { action: { type: 'choice', instructions, criteria } },
  };
}

// -> { raw, finish_reason, decision }; raw is the chosen letter, so parseAction works unchanged.
export function parseDecisionsResponse(body) {
  const answer = body.answers?.action;
  return {
    raw: typeof answer?.choice === 'string' ? answer.choice : '',
    finish_reason: null,
    decision: {
      confidence: answer?.confidence ?? null,
      probabilities: answer?.probabilities ?? null,
      model: body.model ?? null,
      cost: body.usage?.cost ?? null,
    },
  };
}
