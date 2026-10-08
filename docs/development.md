# Development

[← README](../README.md)

```bash
bun start            # http://127.0.0.1:3000
bun test             # engine unit tests
```

## Files

- `public/index.html`, `landing.js`: landing page (game picker)
- `public/play.html`, `arena.js`, `style.css`: generic match page: panes and join toggles, match loop, retry / pause, logging, export. The header comment documents the game adapter interface
- `public/games/registry.js`: game list (shared by the landing page and server)
- `public/games/<id>/engine.js`: rules, prompt generation, output parsing (shared by browser, server and tests; must export `SYSTEM_PROMPT`, `ACTIONS`, `parseAction`)
- `public/games/<id>/game.js`, `style.css`: game adapter (settings, stats, rendering)
- `server.js`: static files + LLM proxy; picks the system prompt by the request's `game`
- `endpoints.js`: format from the endpoint URL; chat and text-completions requests and responses; retry loop for unexpected chat output
- `decisions.js`: Decisions API request building and response parsing
- `test/<id>.test.js`: engine tests; `test/endpoints.test.js`: endpoint formats; `test/decisions.test.js`: Decisions API mapping
- `Dockerfile`, `compose.yaml`, `.dockerignore`: container image and Compose service
- `docs/`: documentation

## Adding a game

1. Create `public/games/<id>/engine.js`, `game.js`, `style.css` (adapter interface: top of `public/arena.js`). `SYSTEM_PROMPT` needs an `Actions:` block with one `X = description` line per action (the Decisions API builds options from it; a missing action stops the game from loading). Also export `decisionQuestion(game)` (see [Decisions API](endpoints.md#decisions-api-system-one-decision-models)) and set it on the adapter
2. Add an entry to `public/games/registry.js`
3. Add `docs/<id>.md` and link it from the README
4. Restart the server (rebuild the image under Docker)
