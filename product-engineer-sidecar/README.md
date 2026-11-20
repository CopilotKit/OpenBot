# Product Engineer sidecar

HTTP service that runs **beside** OpenBot 1.1 (not inside `ghcr.io/copilotkit/openbot`).

```text
Browser (/product-engineer)  →  Vite/ALB /api/product-engineer/*
                                      ↓
                         product-engineer-sidecar
                                      ↓
                    product-engineer-loop + Cursor SDK
                                      ↓
                              Cursor cloud → PRs
```

## Env

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `CURSOR_API_KEY` | yes | [cursor.com/dashboard/api](https://cursor.com/dashboard/api) |
| `LINEAR_API_KEY` | yes | Linear personal/API key (ticket intake) |
| `PE_REPOS` | yes | Comma-separated GitHub clone URLs (frontend + backend) |
| `PE_STARTING_REF` | no | Branch/ref Cursor starts from |
| `PE_MODEL` | no | Default `composer-2.5` |
| `PE_PORT` | no | Default `3020` |
| `PE_RUNS_DIR` | no | JSON run state directory |
| `PE_SIDECAR_TOKEN` | no | If set, require `Authorization: Bearer …` |

## Local

From the repo root (after `bun install`):

```sh
# .env at repo root (or product-engineer-sidecar/.env)
bun run --filter product-engineer-sidecar start
```

Health: `http://127.0.0.1:3020/health`

With OpenBot Vite (`bun run dev`), `/api/product-engineer` is proxied to this port so the app page stays same-origin.

## Compose

```sh
docker compose --profile pe up -d product-engineer
```

See `DEVOPS-HANDOFF.md` for ECS cutover (second task/service).
