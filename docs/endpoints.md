# Endpoint configuration

[← README](../README.md)

Each bot has its own settings, shared by all games: `endpoint`, `api_key`, `model`, `temperature` (default 0). Bots map to panes A, B, C, D in order. The bot count is the larger of the `config.json` entries and the highest pane set by environment variables (2–4; extra `config.json` entries are ignored with a warning).

## Formats

`endpoint` is the full API URL; its path picks the request and response format:

| `endpoint` ends in | Format | Request | `raw` from |
|---|---|---|---|
| `/chat/completions` (e.g. `https://api.openai.com/v1/chat/completions`, `https://openrouter.ai/api/v1/chat/completions`) | OpenAI-compatible chat completions | `messages`: system prompt + user message; `openrouter.ai` also gets `reasoning: { effort: "none" }` | first string in `choices[0].message.content` (the string, or the first text part of an array) |
| `/completions` (e.g. `https://api.openai.com/v1/completions`) | OpenAI-compatible text completions | `prompt`: system prompt, blank line, user message (ending in `Action:`) | `choices[0].text` |
| `/decisions` (e.g. `https://openrouter.ai/api/alpha/decisions`) | OpenRouter Decisions API ([below](#decisions-api-system-one-decision-models)) | one Choice question | `answers.action.choice` |
| `mock://random` | No API: random characters with some invalid output, for UI testing. The default | | |

Any other endpoint is rejected (at startup for `config.json` and env vars; HTTP 400 when saved in the UI). A base URL like `https://api.openai.com/v1` gets a hint to append `/chat/completions`. Non-chat formats appear after the model name in the pane header, e.g. `typesafe/jev-1.13 (decisions)`.

## Sources

Three sources, later ones override earlier:

1. Environment variables: `PANE_A_ENDPOINT`, `PANE_A_API_KEY`, `PANE_A_MODEL`, `PANE_A_TEMPERATURE` (`PANE_B_*`, `PANE_C_*`, `PANE_D_*` for bots 2–4)
2. `config.json`: `{ "panes": [ { "endpoint": ..., "api_key": ..., "model": ..., "temperature": ... }, ... ] }`, one entry per bot, no ids (see `config.example.json`; gitignored)
3. The "Endpoint settings" panel in the UI: server memory only, lost on restart

Legacy settings are rejected at startup with a hint at the replacement: keyed `"panes": { "A": {...} }`, the `base_url` and `api` fields, and `PANE_<id>_BASE_URL` / `PANE_<id>_API`. Unknown `config.json` fields are rejected too.

The api_key stays on the server; the browser only sees `has_api_key: true/false`. The frontend sends the game id, pane id and user message (plus the per-step question for Decisions API panes); the server adds the key and system prompt and forwards to the pane's `endpoint`. An empty api_key in the UI keeps the existing key.

Other environment variables: `HOST` (default `127.0.0.1`), `PORT` (default `3000`), `REQUEST_TIMEOUT_MS` (default 60000).

## Decisions API (System One decision models)

OpenRouter decision models such as `typesafe/jev-1.13`, `~typesafe/jev-latest`, `openai/gpt-6-luna-decisions`, `cloudflare/clef` and `inception/mercury-decide:free` lack `/chat/completions` and work only through the [Decisions API](https://openrouter.ai/docs/guides/community/jev): use the endpoint `https://openrouter.ai/api/alpha/decisions`. On a chat endpoint OpenRouter returns HTTP 400 "… is a decisions model …", and the pane's error suggests the decisions endpoint. Each step sends one Choice question:

```jsonc
{
  "model": "typesafe/jev-1.13",
  "state": { "rules": "<the game's system prompt>", "observation": "<the current user message>" },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "Following the rules, which action should the player take next in the current observation?",
      "criteria": { "L": "move left", "R": "move right", ... }   // from the system prompt's Actions: block
    }
  }
}
```

That generic question is only a fallback; every game supplies its own per step. The adapter's `decisionQuestion(game)` -> `{ instructions, criteria }` is built from the game state and sent by the browser as `decision_question`; the server returns 400 if it names an action the game lacks. Each option is simulated on a copy of the game and states its outcome, so the model compares consequences instead of reading the board. Always on for Decisions API panes, regardless of the helper-info toggles; chat and text-completions panes are unaffected.

Per-game options are described in each game's doc: [Tetris](tetris.md#decisions-api-options), [Snake](snake.md#decisions-api-options) (with an example), [Mario](mario.md#decisions-api-options), [Pinball](pinball.md#decisions-api-options).

The reply's `answers.action.choice` becomes `raw` and goes through the same parser, so scoring and illegal-output checks match across formats. The Decisions API has no `temperature` or `max_tokens` (ignored); `finish_reason` is `null`. Each step log adds `decision`: `confidence`, `probabilities` (per action), `model` (snapshot served), `cost` (USD), `criteria` (this step's options). Exported `panes` record each bot's `endpoint` and `format`.
