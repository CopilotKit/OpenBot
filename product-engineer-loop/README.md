# Product Engineer delivery loop

Orchestrator for: **Linear ticket → Cursor cloud Product Engineer → PR → human/QA feedback → resume until human approves.**

This package is the coding factory that edits repos and opens PRs via the [Cursor SDK](https://cursor.com/docs/sdk/typescript). PlugiQ AgentForce provides the authenticated **dispatch UI** (`/product-engineer`); this package remains the shared library + CLI.

```text
AgentForce (OpenBot)     product-engineer-loop          Cursor cloud
─────────────────────    ─────────────────────          ────────────
Chat, knowledge,         pe-loop start / resume         Product Engineer
grants, audit            Linear fetch + run state       git, tests, PR
```

Merge is always a **human** action. This loop never merges.

## Setup

```bash
cd product-engineer-loop
cp .env.example .env
# fill CURSOR_API_KEY, LINEAR_API_KEY, PE_REPOS
npm install
```

### Where to get `CURSOR_API_KEY`

The screenshot of **Dashboard → Integrations** is the wrong page for this. That page connects **GitHub, Linear, Slack, Teams**, etc. for Cloud Agents. Your screenshot already shows GitHub managed and Linear connected to Descasio — keep those; the agent needs them.

The SDK key is created on a different page:

1. Open **[cursor.com/dashboard/api](https://cursor.com/dashboard/api)** (Dashboard → **API Keys**).
2. Create a **user API key** (or a team **service account** key under team settings).
3. Copy it once into `.env` as `CURSOR_API_KEY=...`.

Docs: [Cursor APIs overview](https://cursor.com/docs/api), [TypeScript SDK auth](https://cursor.com/docs/sdk/typescript).

If you prefer not to mint a key by hand, the SDK can open a browser login and store a key via `Cursor.auth.login()` (see SDK docs). This CLI still expects `CURSOR_API_KEY` in `.env` for unattended runs.

Also set:

- `LINEAR_API_KEY` — [Linear → Settings → API](https://linear.app/settings/api) (used by **this** CLI to fetch the ticket before dispatch; separate from Cursor’s Linear integration).
- `PE_REPOS` — comma-separated GitHub clone URLs the agent may touch.

GitHub access for those repos must exist for the Cursor account that owns the API key (your Integrations → GitHub connection covers that).

## Commands

```bash
# Intake Linear issue, start cloud Product Engineer, open a PR
npm run start -- DES-123
# or: npx tsx src/cli.ts start DES-123 --repo https://github.com/org/frontend

# After human/QA review, send corrections to the same agent
npm run resume -- DES-123 --feedback "Login still 500s when email is empty. Add a test."

# Or from a file
npx tsx src/cli.ts resume DES-123 --feedback-file ./notes.txt

# Inspect persisted state (.runs/DES-123.json)
npm run status -- DES-123

# Human certifies; you still merge in GitHub yourself
npx tsx src/cli.ts approve DES-123
```

Run state (agent id, last run id, PR URL, status) is stored under `.runs/` so `resume` can call `Agent.resume` after the process restarts.

Cloud agents started by the SDK are filtered out of the default agent list in Cursor. Use **Filter → Source → SDK** to find them.

## Loop states

1. **Intake** — Linear GraphQL by identifier (`DES-123`).
2. **Implement** — `Agent.create` + `cloud.autoCreatePR` + standing Product Engineer system prompt.
3. **Awaiting review** — human and/or a separate read-only QA prompt (see `buildQaPrompt` in `src/prompts.ts`).
4. **Revise** — `Agent.resume` + feedback; update the same PR.
5. **Approved** — `pe-loop approve`; merge remains human.

## AgentForce boundary

AgentForce hosts the start / poll / resume / approve UI and server routes at `/api/product-engineer`. Coding still runs on Cursor cloud via this package (`import "product-engineer-loop"`). Use `pe-loop` here for local debugging.

Do **not** implement Product Engineer as an OpenBot bot that pretends to edit Descasio apps via the browser computer. Do **not** dump production frontend/backend into AgentForce demo knowledge. Approve certifies the run; merge stays in GitHub.

## Open-source note

You own this orchestrator and its policy. You do not own Cursor’s agent runtime. If you must vendor the worker, swap the execution box (e.g. OpenHands) and keep the same start / resume / approve states.
