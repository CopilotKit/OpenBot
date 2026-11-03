# NexQN AI architecture

NexQN AI is OpenBot with additions. This document describes only what NexQN adds or changes and
how it attaches to OpenBot. For the base system read [../architecture.md](../architecture.md); it
is upstream's and is not edited here.

## Principles

1. **Modular monolith.** New capabilities are modules inside `server/`, not new services. A new
   container is added only where isolation requires it, and the existing computer container is
   the place for anything that executes untrusted work.
2. **One action boundary.** Every tool call, including a subscription CLI run and a knowledge
   retrieval, goes through the existing gateway: resolve target → grant → action policy → audit →
   act. No NexQN module calls a computer, an MCP server or a model on a Bot's behalf around it.
3. **Extend, don't fork, entities.** NexQN "Agents" are OpenBot Bots (`agents`, `agent_profiles`).
   NexQN "Tools" are OpenBot plugins/MCP servers. NexQN "Workflows" are Routines and
   Responsibilities. A parallel entity would split grants, audit and UI.
4. **Credentials only in the vault.** Provider keys and subscription tokens are `credentials` rows
   (AES-GCM, `KEY_ENCRYPTION_KEY`), referenced by id, never returned by an API.

## Component map

```
Browser ── app/ (React, NexQN tenant package + brand config)
   │
   ▼
server/ (Hono, Bun) ──────────────────────────────────────────────┐
   ├─ auth/            Better Auth, IdPs, roles            (OpenBot)│
   ├─ copilot.ts       CopilotKit runtime / AG-UI          (OpenBot)│
   ├─ plugins/         MCP, Composio, Arcade, grants       (OpenBot)│
   ├─ approvals/       allow / deny / require approval     (OpenBot)│
   ├─ audit.ts         append-only audit_events            (OpenBot)│
   ├─ credentials.ts   vault                               (OpenBot)│
   ├─ routines/ responsibilities/ work/  scheduling, queue (OpenBot)│
   ├─ model-gateway/   provider registry, capabilities     (NexQN)  │
   ├─ subscription-cli/ accounts, login sessions, runs     (NexQN)  │
   └─ knowledge/       bases, documents, retrieval         (NexQN)  │
   │                                                                │
   ├──► agent-* harnesses over AG-UI (model calls)                  │
   ├──► supervisor ──► agent-computer per person/Bot               │
   │                    ├─ Chromium, /workspace, shell              │
   │                    └─ codex / claude CLI runs   (NexQN)        │
   ├──► PostgreSQL (+ pgvector for knowledge)                       │
   └──► CopilotKit Intelligence (threads, memory) — external ───────┘
```

## Model Gateway (`server/src/model-gateway/`)

Builds on `shared/model-providers.json`, which stays the source of *defaults*. Adds a DB registry
an administrator edits at runtime:

- `model_providers`: kind (`openai`, `anthropic`, `google`, `openai_compatible`, `ollama`, `vllm`),
  base URL, credential id (vault), timeout, retry policy, enabled.
- `models`: provider id, model id, display name, capabilities (`text`, `streaming`, `tools`,
  `vision`, `embeddings`, `structured_output`), context limit, max tokens, temperature, default.

Ollama and vLLM are `openai_compatible` with a kind label for UI and model discovery
(`GET /api/tags` for Ollama, `GET /v1/models` for vLLM). The runtime refuses to give a Bot computer
tools when its model lacks `tools`, with a message, instead of failing mid-run.

Usage is recorded as `usage_records` with a `kind` of `api`, `subscription_cli`, `local`, `tool`,
`job`. Token counts are stored only when the provider returned them. Subscription runs record a run
count and duration, never invented token or quota numbers.

## Subscription CLI runtime (`server/src/subscription-cli/`)

```ts
// NexQN's interface, not a vendor one.
interface SubscriptionCliAdapter {
  providerId: "codex" | "claude-code";
  startLogin(account: AccountRef): Promise<LoginSession>;   // device code / setup-token
  getAuthStatus(account: AccountRef): Promise<AuthStatus>;
  execute(req: CliRunRequest, ctx: RunContext): AsyncIterable<CliEvent>;
  cancel(runId: string): Promise<void>;
  logout(account: AccountRef): Promise<void>;
}
```

- **Where it runs:** inside the requesting person's `agent-computer` container, as the non-root
  computer user, in a per-account `CODEX_HOME` / config dir under that container's private volume.
  The API host never executes a CLI.
- **Login on a remote server:** Codex uses `codex login --device-auth`; the app shows the
  verification URL and code, the server polls `codex login status`. Claude uses the token from
  `claude setup-token`, which the person pastes into a secret-entry field (the same secret path the
  computer already uses, never chat), stored in the vault.
- **Storage:** after login, the credential file/token is read once, encrypted into `credentials`
  (kind `subscription_cli`), and deleted from the container. Each run writes it into a tmpfs path,
  runs, and removes it.
- **Isolation:** one account belongs to one person. A Bot uses an account only through an
  `agent_subscription_grants` row created by that account's owner. No fallback to another account,
  no rotation.
- **Execution:** `codex exec --json` / `claude -p --output-format stream-json`, with a timeout,
  cancellation (process-group kill), CPU/memory limits of the computer container, and the Bot's
  egress policy. Output events are normalised to AG-UI events.
- **Audit:** `subscription.login_started`, `.connected`, `.disconnected`, `.run_started`,
  `.run_finished`, `.run_failed`, `.run_cancelled` — never token values.

## Knowledge (`server/src/knowledge/`)

Upstream deleted its document index because it answered as the deployment. NexQN reintroduces one
with ownership designed in:

- `knowledge_bases` (owner, visibility, embedding model id), `knowledge_documents`,
  `knowledge_chunks` (`vector` column, `tsvector` for hybrid search), `agent_knowledge_grants`.
- Ingestion runs on the `work_items` queue (no new worker service): validate → parse → chunk →
  embed → index. Parsing of untrusted files happens in a computer container, not the API process.
- Retrieval is a tool (`search_knowledge`) granted like any other, checked against the asking
  person's access *and* the Bot's grant, then audited. Results carry document and chunk ids for
  citations.

## Organisations

OpenBot is single-tenant per deployment. NexQN keeps that for the first release
(**deployment per customer**) and records the multi-tenant design for later: an `organizations`
table, `organization_id` on every owned row, row-level security in PostgreSQL, and the actor's
organisation resolved once in `request-actor.ts`. This touches every table and route; doing it
before the product is stable would make every upstream merge a conflict.

## Data flow of one turn (unchanged from OpenBot, with NexQN hooks)

1. App sends a turn → server resolves actor and Bot.
2. Server resolves the Bot's model through the Model Gateway (API, local, or subscription).
3. CopilotKit runtime runs the harness over AG-UI.
4. Tool calls return to the server: grant → policy → audit → computer / MCP / knowledge / CLI.
5. Results stream back to the app and to the Intelligence thread.
