# Match rules and UI

[← README](../README.md)

## Match page

The match page is `play.html?game=<id>`; every bot joins by default. Untick a pane's "Join" box to leave it out: the pane collapses to its header and endpoint settings and is dropped from the scoreboard, games table and export. At least two bots must join, so the last two boxes lock. Joining is locked during a run; reloading the page rejoins everyone.

The scoreboard above the boards has one card per joined bot, sorted by live rank (leader first; ties keep pane order), updated every step. "This game" shows live rank (`#1` outlined), score, steps, average latency, illegal rate and, for the Decisions API, average confidence. After a game finishes, "Total" adds wins, win rate, draws, average rank (3–4 bots), game averages, latency, illegal rate and end reasons. "Per-game details", collapsed by default, holds the games table.

- "Latest LLM input" under each pane shows the user message sent; the system prompt is at the bottom of the page.
- "Decision log" under each pane is collapsed by default so several boards fit; its title shows the step count. It lists every step of the current game, newest first: chosen action (with raw when different, `✕` for illegal), step result, latency and, for the Decisions API, per-action probability bars (chosen one outlined) and confidence. Click a row for the full input, probability values, Decisions API options, model snapshot and cost. Above the list: action mix, illegal rate, average confidence. Cleared each game; full history is in the [export](export.md).

## Common rules

- Chat and text-completions requests use `max_tokens: 1` and the configured `temperature`, and send only the system prompt and current state, no history. Every side gets the same system prompt and input format.
- Chat requests to OpenRouter add `reasoning: { effort: "none" }`; otherwise reasoning models on chat completions (e.g. `openai/gpt-6-luna`) spend the one token on hidden reasoning and return `content: null`. Non-reasoning models ignore it. Other hosts don't get it, since some providers reject unknown fields.
- Parsing: `raw.trim().slice(0,1).toUpperCase()` (i.e. `response.strip()[:1].upper()`). Anything outside the action set is a no-op, counted as illegal; time still advances.
- Game i (0-based) uses seed = configured seed + i, the same on every side.
- Ranking: competition ranking by score (ties share a rank, e.g. 1, 1, 3). The sole first place wins; a shared top score is a draw. With 3–4 panes the scoreboard also shows average rank.
- **Pause** doesn't cancel an in-flight request; it stops after that step is applied.
- Helper-info toggles are off by default, identical on every side, and saved in the export's `settings`.

## Errors

- **Unexpected chat output**: chat completions is not a decisions API, so a model may reply with anything. When a chat reply doesn't parse as an action (e.g. `Sure`, empty, `content: null`), the server re-sends the same request up to 5 times (6 requests total). The step's `latency_ms` sums all attempts; the log records `retries` and `rejected`; the pane shows the total as "Output retries". If the 6th reply still fails, the **whole match stops** ("Match aborted"): all panes stop, the status line names the pane, game and step, and the pane shows "Unexpected output" with the rejected replies. The export gets `aborted` and keeps the unfinished game in `in_progress` (end reason `unexpected_output`). Text completions, the Decisions API and `mock://` keep the illegal-output rule.
- **API errors** (network, non-2xx) retry 3 times at 0.5s / 1s / 2s. If still failing, only that pane stops for this game: it shows the error, ends with `api_error` (message stored in the result's `api_error`), and keeps its score. The match doesn't pause; others play on, and the game ends when all panes finish or fail. The next game restarts every pane, so a fixed endpoint rejoins.
