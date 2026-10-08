# System-1 LLM Arena

Pits system-one (non-reasoning, fast) LLMs against each other in small games. Each bot (up to four, panes A–D) gets its own board; all boards run at once with the same seed. Each step makes one LLM call per bot and uses the first character of the reply as the action.

## Quick start

Requires [Bun](https://bun.sh) 1.3+; no packages to install.

```bash
cp config.example.json config.json   # set each bot's endpoint, api_key, model
bun start                            # http://127.0.0.1:3000
bun test                             # engine unit tests
```

Or with Docker: `docker compose up -d --build` (see [Docker](docs/docker.md)).

## Games

| Game | Id | Actions |
|---|---|---|
| [Tetris](docs/tetris.md) | `tetris` | `L` `R` `U` rotate, `D` down, `S` hard drop |
| [Snake](docs/snake.md) | `snake` | `U` `D` `L` `R` |
| [Mario-style platformer](docs/mario.md) | `mario` | `R` `L` `J` jump right, `U` jump up, `N` stay |
| [Pinball](docs/pinball.md) | `pinball` | `L` `R` `B` both flippers, `N` none |

## Docs

- [Endpoint configuration](docs/endpoints.md): chat completions, text completions, OpenRouter Decisions API, env vars and `config.json`
- [Match rules and UI](docs/match.md): scoreboard, parsing, ranking, retries and errors
- [Exported JSON](docs/export.md): match export format
- [Docker](docs/docker.md): Compose and plain `docker run`
- [Development](docs/development.md): file layout and adding a game
