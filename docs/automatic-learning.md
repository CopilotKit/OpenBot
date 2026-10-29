# Automatic Learning

Open **Admin → Automatic Learning** to choose which Bots contribute completed conversations to a CopilotKit Intelligence Learning container and receive its published skills. Learning defaults on for managed and self-hosted deployments; a saved off setting is preserved. Collection and delivery require an existing, assigned container. OpenBot still starts and chats without one.

Out of the box, OpenBot assigns that container itself: when nothing is saved in Admin and no container is named in the environment, the server makes its Intelligence project's `openbot` container the default as soon as that container exists. See [Automatic assignment](#automatic-assignment).

Desktop sign-in creates or reuses the selected project's `openbot` container. Managed setup uses CopilotKit sign-in; self-hosted setup uses that deployment's normal browser sign-in and requires installed Chrome or Edge. Start saves the assignment only while the provisioned key and API still match, and preserves an explicit custom container in `.env`. Saved Admin settings, including off or an empty default, remain authoritative.

For a fresh managed clone, copy `.env.example` to `.env`, then run from the OpenBot root:

```sh
bun install
npx --yes copilotkit@latest login
npx --yes copilotkit@latest project select
bun scripts/setup-learning.ts
```

The helper provisions a key for the selected project, creates or reuses its `openbot` container, and verifies the response before writing `INTELLIGENCE_API_KEY` and `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`. It preserves custom targets and never replaces an existing OpenBot runtime key: with one already set, it only makes sure `openbot` exists in that key's project (see below).

For fresh self-hosted setup, set `INTELLIGENCE_API_URL` to the deployment's HTTPS API origin and run `bun scripts/setup-learning.ts` after `bun install`; skip the managed CLI commands. Install Google Chrome or Microsoft Edge first. The helper opens an isolated browser for your deployment's sign-in, lists your accessible projects, and creates or reuses `openbot` before minting a key for the chosen project. It keeps sign-in cookies only in that temporary browser and closes it on completion, cancellation, or timeout. HTTP is supported only for loopback development. Run this operator setup on a computer whose browser can reach Intelligence, including when preparing a remote web or Helm deployment; transfer the generated runtime key using your normal secret management and set the container ID to `openbot`.

A runtime key alone cannot create a container: Intelligence serves container creation only to a person's session or CopilotKit CLI login. For a deployment that already has a key, `bun scripts/setup-learning.ts` asks that key whether its project has `openbot`. If it does not, the helper creates it with your credential: on managed Intelligence through the CLI, but only after confirming, before anything is created, that the CLI login's organization and project are the key's (the organization by name, since the CLI reports no slug, and the project by slug and name, and the selected one when one is selected); on self-hosted Intelligence through the same browser sign-in as fresh setup, without minting a new key. Either way the key itself must then see the container, or nothing counts. The helper writes nothing to `.env`; the server assigns the container on its own. `scripts/start.sh` runs the same check with `--non-interactive` on every start, so a checkout with a CLI login gets the container without anybody running the helper. That mode never opens a browser, prompts, or provisions a key, and it never stops OpenBot starting.

Custom container assignments, and deployments that cannot run the helper, use authenticated Intelligence administration and these manual steps:

1. In the same Intelligence project used by OpenBot, create a Learning container. Its stable ID contains 1–64 lowercase letters, digits, and single hyphens (for example, `support-learning`).
2. In OpenBot, enter the default container ID and re-enable Learning if previously paused. Leave the default empty to opt in only particular Bots. Each Bot can inherit the default, use another container, or be excluded. Save the settings.
3. Start **new threads** and complete relevant workflows. Chat, channels, scheduled routines, and handoffs use the same server-side settings. An existing thread keeps the first container assignment (including an unassigned first run); changing a Bot mapping does not move or backfill its earlier evidence.
4. Use **Manage Learning in Intelligence**, **View analysis runs**, and **Review skill candidates** on the Learning page. Intelligence collects evidence, runs analysis, and proposes skills. Review the source evidence and publish approved revisions in Intelligence. Neither a scheduled analysis nor enabling Learning automatically approves a skill.
5. Enable skill delivery for that container in Intelligence and start another Bot invocation. Published guidance is loaded into the Bot's governed run. An exact revision pin keeps a specific published revision; leaving it empty follows new publications after the refresh window. A loaded snapshot alone does not prove the model used a skill: inspect its skill tool calls too.

For live voice calls with a Learning-enabled Bot, substantive answers, explanations, recommendations, research, and actions are delegated through the existing `ask_agent` channel run. That selected Bot's AG-UI run and Rich Threads provide the Learning evidence and published guidance. Brief spoken acknowledgments, clarification, and reading or summarizing its returned answer remain audio and are not evidence. The voice session reads participation when it starts: restart the call after changing Learning settings. Neither the skill snapshot nor the Intelligence project key is sent to the realtime voice provider.

Pausing OpenBot Learning preserves its mappings and thread assignments. It stops new OpenBot assignments and delivery. Previously bound threads remain in their Intelligence containers; pause analysis in Intelligence to stop learning from those containers. Delivery uses the current per-Bot policy on fresh invocations. Intelligence's existing evidence, scheduled analysis, publication, and separate delivery controls remain managed there.

## Automatic assignment

With no container assigned, the server asks Intelligence, using its runtime key, whether the project has a container with ID `openbot`. If it does, the server saves it as the default, exactly as an administrator saving it in Admin would, and records a `configuration.changed` audit row initiated by the deployment. It asks at start, every ten minutes, and when a turn or the Admin page reads Learning settings, at most once a minute. A container created later is picked up without a restart.

- It never overrides a choice. Any saved Admin setting, including off or an empty default, means there is nothing to do, and so does `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`.
- It creates the container only with a credential that can, never with the runtime key. See [Creating the container](#creating-the-container).
- It is safe on many replicas. The save only succeeds where nothing was ever saved, so one replica wins and writes the audit row.
- It never blocks startup or a turn. A missing container, a plan without Learning, or an unreachable Intelligence is logged once as a `learning-auto-assign` line and tried again later. The Admin page says which one applies.
- `OPENBOT_LEARNING_AUTO_ASSIGN=false` (Helm: `config.learning.autoAssign: false`) turns it off.

## Creating the container

Intelligence creates Learning containers (`POST /api/learning/projects/:projectId/containers`) for three callers only: a person's browser session, a CopilotKit CLI login, and a service token, which counts only on a CopilotKit local evaluation install. A project's runtime key is none of them. So OpenBot creates `openbot` wherever it holds one of those, proves the result with the runtime key (a container the key cannot see is in another project and is reported, never assigned), and otherwise says exactly what to run:

| Where | Credential | What happens |
| --- | --- | --- |
| `bun run start` / `scripts/start.sh` | Your CLI login (`npx --yes copilotkit@latest login`) | Every start runs `scripts/setup-learning.ts --non-interactive`. With no project selected in the checkout, it lists the projects your login can see and uses the runtime key's, from a scratch directory, so nothing in the checkout is selected or rewritten. With no login on the machine it does not download the CLI. |
| `bun scripts/setup-learning.ts` | CLI login (managed) or browser sign-in (self-hosted) | As above, interactively; self-hosted opens a browser. |
| Server, at start and from Admin | `INTELLIGENCE_SERVICE_TOKEN` + `INTELLIGENCE_PROJECT_ID` (local evaluation installs), or a CLI login on the same machine | Creates it once at start if it is missing. **Admin → Automatic Learning** shows **Create the openbot container** when one of these is present, to try again. |
| Helm | `config.learning.setup.cliLoginSecret` or `serviceTokenSecret` + `projectId` | A Job per release revision runs `server/src/learning/ensure-container.ts` and exits; the server assigns the container on its next check. The CLI login is used by that Job only. |
| Desktop app | CopilotKit or self-hosted sign-in | Connecting creates or reuses the selected project's `openbot` (above). |

With none of them, the `learning-auto-assign` log line and the Admin page name the exact steps for your Intelligence: for managed, sign in with the CLI and run the helper (or give the chart a CLI login); for self-hosted, run the helper and sign in, or set a service token on a local evaluation install. Creating a container with ID `openbot` in Intelligence by hand works everywhere.

## Each person's own Learning space

Recordings made with the OpenBot Recorder do not belong to a Bot. Every recording a person makes joins their own Learning container, `user-` and the first 32 hex digits of the SHA-256 of their OpenBot user id, whichever Bot they later use. The id is derived, so every replica names the same container for the same person without looking anything up, and two people never share one.

- **Made on first need.** When a person connects a browser, OpenBot makes their container in the background with the same credential it uses for `openbot`: a service token on a local evaluation install, or a CopilotKit CLI login against managed Intelligence (see the table above). A capture pass that finds it still missing makes it on the spot when the credential is a service token, which answers well inside the pass's deadline; the CLI is slower, which is why connecting starts it first. Intelligence's container id is unique per project, so replicas racing to make the same container all end up with it. With no such credential, a missing container cannot be made, and the Recorder's popup says Learning will not see the recording (it still goes to Intelligence). Creating a container with that id in Intelligence by hand works too.
- **Every Bot the person uses draws on it.** A run gets the Bot's own published Skills (its Learning target, as above), then the person's own, then any Skills another person opened. On a name clash the Bot's own wins, then the person's own; when two people opened Skills with the same name, both are kept, each named `<their container>/<name>`. A person's container that is missing, refusing or slow never fails a run: the run goes on with the Skills it has, and runs leave a refusing container alone for a minute. Learning switched off here, or a Bot excluded here, still means no learned Skills at all for that Bot.
- **Who else may use them.** In **Settings → Learning** each person chooses: only their own Bots (the default), every Bot in the deployment, or the Skills they open one by one. Runs read what is open from an index held in memory, read again at once on the replica that saved a change and within 30 seconds everywhere else, so no run asks each person's container who shares what. Each change writes a `learning.sharing_changed`, `learning.skill_opened` or `learning.skill_closed` audit row.
- **Not deleted from here.** Intelligence has no API a server credential can call to delete a recording, or a container that still holds one, so recordings cannot be deleted from OpenBot yet, and a person's recordings stay in their container after they are removed from OpenBot (see [Authentication](configuration.md#authentication)).

Thread assignment is unchanged: a conversation's evidence still goes to its Bot's container.

## Credentials and permissions

OpenBot reuses its **server-side** `INTELLIGENCE_API_KEY` and `INTELLIGENCE_API_URL`. Setup creates containers using the authenticated account, not the runtime key. Automatic assignment uses the runtime key only to read whether `openbot` exists in its own project. Never put the project key in browser environment variables. The Learning settings and inspection endpoints require an OpenBot administrator; settings writes also require same-origin JSON requests (or an explicitly trusted app origin).

The project key supports runtime ingestion, skill delivery, and the read-only Inspector Learning projection. It is not a management credential. Review, run, schedule, and publish links open the existing Intelligence UI, where you sign in with an account authorized for that project. OpenBot does not proxy management writes using its project key.

The admin page reports evidence and published-skill counts, analysis status, and available delivery diagnostics. An unavailable status is displayed as an error with a retry action, not as an empty container. Server errors and project credentials are not exposed in those messages.

## Managed and self-hosted deployments

For managed Intelligence, keep the existing managed API and gateway configuration. Configure the container in its associated project. For an Enterprise self-hosted Intelligence deployment, use its API and gateway endpoints and the same project's key. Install the Intelligence release and migrations that support Automatic Learning, the Inspector Learning endpoint (`GET /api/inspector/learning`), and published skill delivery before assigning a container in OpenBot. Links come from that server's configured web-app origin, so self-hosted administration opens the correct UI.

OpenBot's database migrations add `learning_settings` and `learning_thread_bindings`, and for each person's own space `learning_person_spaces`, `learning_skill_sharing` and `learning_open_skills`; run the normal deployment migrations. The settings are read from the database across replicas, and thread assignment is atomic.

Operators may seed an initial default in the API server environment:

```dotenv
CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=support-learning
# Optional opaque published revision ID; omit to follow latest.
CPK_INTELLIGENCE_SKILLS_REVISION=exact-revision-id
```

These are optional defaults, not additional startup requirements. Once an administrator saves settings, those saved settings take precedence, including a saved off state. Helm exposes the defaults as `config.learning.containerId` and `config.learning.revision`. Local development reads them from `.env`; desktop installations can use the Admin page without modifying native configuration. The revision is an opaque ID, not a number to increment or a special `auto` value.

Built-in agents receive published guidance through the CopilotKit runtime. OpenBot's shipped remote agents receive the server-selected, verified skill snapshot for each run; they do not require the Intelligence project key. Bring-your-own remote agents must consume that forwarded context (or configure the framework's supported native adapter) to use delivered guidance; evidence collection alone does not alter a third-party agent's prompt. Keep existing tool grants, boundaries, credentials, and manually authored slash skills in place: learned guidance does not grant tools or replace them.

See the canonical [Automatic Learning guide](https://docs.copilotkit.ai/learning) and [skill delivery guide](https://docs.copilotkit.ai/intelligence/learned-skills) for current deployment requirements and review behavior.
