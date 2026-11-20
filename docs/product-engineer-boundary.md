# Product Engineer (coding factory)

Linear ticket → Cursor cloud Product Engineer → PR → human feedback → resume → approve.

## Where it lives (OpenBot 1.1)

| Surface | Role |
| -------- | ---- |
| **AgentForce** (`/product-engineer`) | Authenticated **dispatch UI**: start a run, poll status, submit feedback, approve. Browser talks to `/api/product-engineer/*` (Vite/ALB proxies to the sidecar). |
| **`product-engineer-sidecar`** | Holds `CURSOR_API_KEY` / `LINEAR_API_KEY`, calls `@cursor/sdk`, persists runs under `PE_RUNS_DIR`. **Not** inside `ghcr.io/copilotkit/openbot`. |
| **Cursor cloud** | Does the coding work (`Agent.create` / `Agent.resume`, `autoCreatePR`). |
| **[`product-engineer-loop`](../product-engineer-loop)** | Shared library + CLI (`pe-loop`) for local debugging of the same loop. |
| **Chat skill `implement-a-ticket`** | Directs people to `/product-engineer`. In-process Bot MCP tools from September are not in the published image. |

Coding runs on Cursor cloud, not in a Bot computer. Approve certifies the run; **merge stays in GitHub**.

## Prerequisites

1. Set `CURSOR_API_KEY`, `LINEAR_API_KEY`, and `PE_REPOS` for the sidecar (see `.env.example` / `product-engineer-sidecar/README.md`).
2. Run the sidecar (`bun run dev:pe` or Compose profile `pe`).
3. Grant the Cursor GitHub App access to any **private** repos in `PE_REPOS` (Dashboard → Integrations).
