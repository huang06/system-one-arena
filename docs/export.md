# Exported JSON

[← README](../README.md)

```jsonc
{
  "tool": "system1-llm-arena", "version": 2, "game": "tetris",
  "settings": { "seed", "games", "step_delay_ms", ...game settings },   // e.g. tetris: max_pieces, max_steps_per_piece, column_heights, holes
  "system_prompt": "...",
  "panes": { "A": { "endpoint", "model", "temperature", "format" }, "B": { ... }, ... },   // joined panes only; no api_key; format: chat, completions, decisions or mock
  "summary": { "games", "draws", "panes": { "A": { "wins", "win_rate", "avg_rank", "avg_<field>", "avg_latency_ms", "illegal_rate", "end_reasons": { "topout": 3, ... } } } },
  "games": [{
    "index", "seed", "winner", "ranks": { "A": 1, "B": 2, ... },   // winner: pane id or "draw"
    "results": { "A": { "score", ...game results, "steps", "illegal", "output_retries", "api_errors", "avg_latency_ms", "end_reason" } },
    "logs": { "A": [{ "i", "t", ...state before the request, "raw", "finish_reason", "latency_ms", "decision"?, "retries"?, "rejected"?, "legal", "action", ...step results, "score" }] }   // retries: chat panes only
  }],
  "in_progress": { ... },  // only when exported mid-run or after an abort; the unfinished game
  "aborted": { "pane", "model", "game", "step", "error", "rejected", "at" }   // only when unexpected chat output stopped the match
}
```

`t` is when the request was sent; `latency_ms` is the upstream time measured by the server. `decision` is described under [Decisions API](endpoints.md#decisions-api-system-one-decision-models); `retries` and `rejected` under [Errors](match.md#errors).

Game-specific step log and result fields: [Tetris](tetris.md#log), [Snake](snake.md#log), [Mario](mario.md#log), [Pinball](pinball.md#log).
