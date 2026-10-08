# Docker

[← README](../README.md)

```bash
docker compose up -d --build    # http://localhost:3000
docker compose logs -f
docker compose down
```

- **`config.json`**: copy from `config.example.json`. `compose.yaml` mounts it read-only at `/app/config.json`, so it must exist.
- **`.env`** (optional, not committed): [environment variables](endpoints.md#sources), e.g. `PANE_A_ENDPOINT=https://openrouter.ai/api/v1/chat/completions`. Uncomment `env_file:` in `compose.yaml`.

The container listens on `0.0.0.0:3000`. Without Compose:

```bash
docker build -t system1-llm-arena .
docker run --rm -p 3000:3000 -e HOST=0.0.0.0 -e PORT=3000 --env-file .env system1-llm-arena
```

Endpoint settings changed in the web UI live in server memory and are lost on restart.
