# Development

## Setup

Install Docker, [Bun](https://bun.sh) 1.4+ (the tests need it), `lsof`, `openssl`, and `curl`. The
Intelligence provisioning below also needs `npx` (Node); `scripts/start.sh` uses `openssl` to mint
the generated secrets on a first run.

```sh
cp .env.example .env
bun install
```

Provision CopilotKit Intelligence after `.env` exists:

```sh
npx --yes copilotkit@latest login
npx --yes copilotkit@latest project select
bun scripts/setup-learning.ts
```

For fresh managed setup, the helper provisions the selected project's key and creates or reuses
its `openbot` Learning container. It writes `INTELLIGENCE_API_KEY` and
`CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` to `.env` only after verifying the container. Existing
keys and custom targets are preserved. For fresh self-hosted setup, set `INTELLIGENCE_API_URL`
to the deployment's HTTPS API origin and run only `bun scripts/setup-learning.ts`. Install
Chrome or Edge first: the helper opens an isolated browser window for the deployment's usual
sign-in, lets you choose an accessible project, and creates or reuses `openbot` before minting
its runtime key. Local development may use a loopback HTTP origin. Existing key-only setups
use authenticated Intelligence administration to create a container and assign it in OpenBot Admin.
There is no managed license step. Then add `OPENAI_API_KEY`.

The same CLI sign-in also prepares Composio on the first `bash scripts/start.sh`;
`bun run setup:composio` runs that step alone, independently of Learning. A failure
does not stop the start: OpenBot runs with apps unavailable until a retry succeeds. A supplied
`COMPOSIO_API_KEY`, an explicit Arcade selection, or an Arcade-only key is preserved.
The helper saves a stable installation UUID privately before any provisioning request,
then the CLI saves this installation's Composio project key in `.env`. Keep
`.env.openbot-installation-id` with the installation when restarting or retrying;
new installations generate their own file. A compatible published CLI and enabled hosted
provisioning service must be available before adopting this startup flow. See
[automatic project setup](plugins/composio.md#automatic-project-setup).

Start the stack:

```sh
bash scripts/start.sh
```

## Windows (WSL 2)

On Windows, run the clone inside WSL 2 with Ubuntu. This was checked on Windows Server 2022 with
Ubuntu 26.04.

1. Install WSL 2 and Ubuntu with [Microsoft's instructions](https://learn.microsoft.com/windows/wsl/install)
   (`wsl --install` in an administrator PowerShell), and restart Windows when it asks.

2. In an Ubuntu terminal, install the tools from [Setup](#setup). A new Ubuntu 26.04 had none of them,
   and Bun's installer stops without `unzip`:

   ```sh
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl git lsof openssl unzip nodejs npm
   curl -fsSL https://bun.sh/install | bash
   ```

3. Install Docker Engine and its Compose plugin inside Ubuntu with
   [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/), then let your
   user run it and open a new Ubuntu terminal:

   ```sh
   sudo usermod -aG docker $USER
   ```

4. Clone into your Ubuntu home directory, for example `~/OpenBot`, and follow [Setup](#setup) from
   there. `npx --yes copilotkit@latest login` opens the sign-in page in your Windows browser.

5. Keep an Ubuntu terminal open while you use OpenBot. WSL stops Ubuntu shortly after its last
   terminal closes, and the app, the API server and Docker stop with it.

6. Open the app from your Windows browser at <http://127.0.0.1:3010>. WSL forwards the port, and
   <http://localhost:3010> works too.

## Running services

Use `bash scripts/start.sh` for the full local stack. It starts Docker services, applies migrations, starts the API server and the routine worker, starts the app, and verifies health routes.

The API server, the routine worker, the migrations, the computer and the supervisor run from the published OpenBot images, pulled at the one tag in `backend-images.env`: `main` on the `main` branch, the images built from main, and the release's own version (`v1.0.3`) in a release's checkout, which the release PR pins. `start.sh` pulls them on every start, so `main` is current; offline, or with `IMAGE_PULL_POLICY=never`, it uses the copies already on the machine. An `OPENBOT_BACKEND_TAG` in the environment or `.env` runs another build. The app runs from this checkout, with Vite, so a change to it shows as you save; its `/api` calls go to the server's container on port 3001. The server's log is `docker compose logs server`, and the worker's `docker compose logs worker`. Run Compose by hand with `--env-file backend-images.env --env-file .env`, so it pulls the same images.

Use `bash scripts/stop.sh` to take it down: the app, the routine worker, the API server, the Docker services, and each Bot's computer, which the supervisor makes rather than compose and which therefore outlives `docker compose down`. Pass `--keep-computers` to leave those browsers signed in. Nothing is deleted either way.

Use `bun run dev` only when you want the app on its own, against a server that is already running.

| Service           | Port                       |
| ----------------- | -------------------------- |
| `app`             | 3010                       |
| `server`          | 3001                       |
| `agent-computer`  | 4100                       |
| `agent-langgraph-agui` | 4201 host / 4206 container |
| `supervisor`      | 4500 host / 4300 container |
| PostgreSQL        | 5432                       |

`start.sh` hands every selected Docker service, the API server and the worker included, to `docker compose up -d` on every run, so one whose configuration or image changed is recreated and an unchanged one is left as it is. It recreates the server when it generated a secret, leaves an app that already answers as OpenBot alone, and reports when a port is held by another process.

**Nothing here sweeps staged attachments.** A file dropped into the composer is stored before the
message is sent, and the only thing that reclaims the ones never sent is the server image's
`openbot cull-staged-attachments`, which the Helm chart runs hourly and which neither
`docker-compose.yml` nor `start.sh` starts. Run it with
`docker compose --env-file backend-images.env --env-file .env run --rm --no-deps server openbot cull-staged-attachments`.
It needs only `DATABASE_URL`, and takes a retention window in hours as its one optional argument,
defaulting to 24. On a laptop that is
usually nothing, because the rows are small and the database is yours. It stops being nothing at
thirty-two: one person may hold that many unsent files across every channel at once, the refusal on
the next one promises they are cleared within a day, and where nothing sweeps they are not, so a
long-lived local deployment can reach a state where attaching anything is refused. Removing a file
in the composer deletes it outright, so it takes abandoned drafts rather than ordinary use.
[deployment.md](deployment.md) says the same for a real deployment.

## Migrations

The database schema and its migrations come with the server image. `start.sh` applies them with the
`migrate` service before it starts the server, every run, and a database that is already current is
left as it is.

## Quality checks

Run these before opening a pull request:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

CI uses `bun run test:ci` to verify the expected test count in addition to normal tests. It runs the suite in shards, one runner each, and the `tests` check passes only when every shard passed and their counts add up to the floor in `scripts/test-floor.ts`. To run one shard the way CI does, pass it to the same script: `bun run test:ci --shard=2/4`.

`bun run test:smoke` is separate and needs a deployment that is up, and a session on it:

```sh
bash scripts/start.sh
export OPENBOT_SMOKE_COOKIE='better-auth.session_token=...'
bun run test:smoke
```

It drives one journey over HTTP against the running stack, so it covers the joins the rest of the
suite cannot reach: server to supervisor to computer, the gateway deciding before the browser acts,
and the audit row landing. Point it elsewhere with `OPENBOT_API_URL`. Without a deployment it is
skipped by `bun run test` and says what to start when asked for by name.

The session is not optional and not a convenience. Every route the journey proves is behind
`requireUser`, so without one the three tests that act on a computer answer 401 and the run reports
a broken deployment when nothing is broken. Take the cookie from a browser already signed in to the
deployment under test, from DevTools under Application, Cookies. It is a credential with that
person's reach: it belongs in the environment of the run, not in a file or a pull request comment.
Asked for without it, the run stops before the first test and names the variable.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../README.md) when behavior changes.
- Run the quality checks above and include the results in the pull request.
