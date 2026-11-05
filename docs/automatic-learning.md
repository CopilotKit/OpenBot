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

The helper provisions a key for the selected project, creates or reuses its `openbot` container with that key, and writes `INTELLIGENCE_API_KEY` and `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`. It preserves custom targets and never replaces an existing OpenBot runtime key: with one already set, it only makes sure `openbot` exists in that key's project. The server does the same by itself at start, so with a key already set the helper is optional.

For fresh self-hosted setup, set `INTELLIGENCE_API_URL` to the deployment's HTTPS API origin and run `bun scripts/setup-learning.ts` after `bun install`; skip the managed CLI commands. Install Google Chrome or Microsoft Edge first. The helper opens an isolated browser for your deployment's sign-in, lists your accessible projects, and creates or reuses `openbot` before minting a key for the chosen project. It keeps sign-in cookies only in that temporary browser and closes it on completion, cancellation, or timeout. HTTP is supported only for loopback development. Run this operator setup on a computer whose browser can reach Intelligence, including when preparing a remote web or Helm deployment; transfer the generated runtime key using your normal secret management and set the container ID to `openbot`.

OpenBot needs Intelligence 0.16.0 or later for Learning setup: from that release a runtime key creates Learning containers in its own project (`POST /api/v1/learning/containers`), and the server does that by itself for `openbot` and for each person's own space. See [Creating the container](#creating-the-container).

Custom container assignments, and deployments that cannot run the helper, use authenticated Intelligence administration and these manual steps:

1. In the same Intelligence project used by OpenBot, create a Learning container. Its stable ID contains 1–64 lowercase letters, digits, and single hyphens (for example, `support-learning`).
2. In OpenBot, enter the default container ID and re-enable Learning if previously paused. Leave the default empty to opt in only particular Bots. Each Bot can inherit the default, use another container, or be excluded. Save the settings.
3. Start **new threads** and complete relevant workflows. Chat, channels, scheduled routines, and handoffs use the same server-side settings. An existing thread keeps the first container assignment (including an unassigned first run); changing a Bot mapping does not move or backfill its earlier evidence.
4. Intelligence collects evidence, runs analysis, and proposes skills. Review them under **Proposed skills** on the Learning page: each one shows its SKILL.md, why it was proposed, and the conversations and recordings it was learned from, with **Approve and publish** and **Reject**. **Learn now** starts an analysis at any time. Where Intelligence has a dashboard, **Manage Learning in Intelligence**, **View analysis runs**, and **Review skill candidates** open it as well. Neither a scheduled analysis nor enabling Learning automatically approves a skill.
5. Enable skill delivery for that container in Intelligence and start another Bot invocation. Published guidance is loaded into the Bot's governed run. An exact revision pin keeps a specific published revision; leaving it empty follows new publications after the refresh window. A loaded snapshot alone does not prove the model used a skill: inspect its skill tool calls too.

For live voice calls with a Learning-enabled Bot, substantive answers, explanations, recommendations, research, and actions are delegated through the existing `ask_agent` channel run. That selected Bot's AG-UI run and Rich Threads provide the Learning evidence and published guidance. Brief spoken acknowledgments, clarification, and reading or summarizing its returned answer remain audio and are not evidence. The voice session reads participation when it starts: restart the call after changing Learning settings. Neither the skill snapshot nor the Intelligence project key is sent to the realtime voice provider.

Pausing OpenBot Learning preserves its mappings and thread assignments. It stops new OpenBot assignments and delivery. Previously bound threads remain in their Intelligence containers; pause analysis in Intelligence to stop learning from those containers. Delivery uses the current per-Bot policy on fresh invocations. Intelligence's existing evidence, scheduled analysis, publication, and separate delivery controls remain managed there.

## Automatic assignment

With no container assigned, the server asks Intelligence, using its runtime key, whether the project has a container with ID `openbot`. If it does, the server saves it as the default, exactly as an administrator saving it in Admin would, and records a `configuration.changed` audit row initiated by the deployment. It asks at start, every ten minutes, and when a turn or the Admin page reads Learning settings, at most once a minute. A container created later is picked up without a restart.

- It never overrides a choice. Any saved Admin setting, including off or an empty default, means there is nothing to do, and so does `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID`.
- It creates a missing `openbot` with the runtime key, once per process. See [Creating the container](#creating-the-container).
- It is safe on many replicas. The save only succeeds where nothing was ever saved, so one replica wins and writes the audit row.
- It never blocks startup or a turn. A missing container, a plan without Learning, or an unreachable Intelligence is logged once as a `learning-auto-assign` line and tried again later. The Admin page says which one applies.
- `OPENBOT_LEARNING_AUTO_ASSIGN=false` (Helm: `config.learning.autoAssign: false`) turns it off.

## Creating the container

The server creates `openbot` with its own runtime key when the project does not have it: at start, and again when an administrator presses **Create the openbot container** in **Admin → Automatic Learning**. The request names no project, so Intelligence creates it in the key's own project, and it is idempotent by id, so replicas racing to create it all end up with the same container. Nothing else is needed: no CLI login, service token or setup Job.

That route arrived in Intelligence 0.16.0. On an older Intelligence, or one with Learning switched off, the server cannot create it, and the `learning-auto-assign` log line and the Admin page say so. Creating a container with ID `openbot` in Intelligence by hand works everywhere, and the server assigns it within ten minutes.

The desktop app's sign-in creates or reuses the selected project's `openbot` as part of connecting.

## Each person's own Learning space

Recordings made with the OpenBot Recorder do not belong to a Bot. Every recording a person makes joins their own Learning container, `user-` and the first 32 hex digits of the SHA-256 of their OpenBot user id, whichever Bot they later use. The id is derived, so every replica names the same container for the same person without looking anything up, and two people never share one.

- **Made on first need.** When a person connects a browser, OpenBot makes their container in the background with the runtime key, as it does `openbot`, and a capture pass that finds it still missing makes it on the spot. Intelligence's container id is unique per project, so replicas racing to make the same container all end up with it. When Intelligence cannot make it (older than 0.16.0, or Learning switched off), the Recorder's popup says Learning will not see the recording (it still goes to Intelligence). Creating a container with that id in Intelligence by hand works too.
- **Every Bot the person uses draws on it.** A run gets the Bot's own published Skills (its Learning target, as above), then the person's own, then any Skills another person opened. On a name clash the Bot's own wins, then the person's own; when two people opened Skills with the same name, both are kept, each named `<their container>/<name>`. A person's container that is missing, refusing or slow never fails a run: the run goes on with the Skills it has, and runs leave a refusing container alone for a minute. Learning switched off here, or a Bot excluded here, still means no learned Skills at all for that Bot.
- **Who else may use them.** In **Settings → Learning** each person chooses: only their own Bots (the default), every Bot in the deployment, or the Skills they open one by one. Runs read what is open from an index held in memory, read again at once on the replica that saved a change and within 30 seconds everywhere else, so no run asks each person's container who shares what. Each change writes a `learning.sharing_changed`, `learning.skill_opened` or `learning.skill_closed` audit row.
- **Not deleted from here.** Intelligence has no API a server credential can call to delete a recording, or a container that still holds one, so recordings cannot be deleted from OpenBot yet, and a person's recordings stay in their container after they are removed from OpenBot (see [Authentication](configuration.md#authentication)).

Thread assignment is unchanged: a conversation's evidence still goes to its Bot's container.

## Credentials and permissions

OpenBot reuses its **server-side** `INTELLIGENCE_API_KEY` and `INTELLIGENCE_API_URL`. The server creates containers with the runtime key where Intelligence allows it, and the setup helper with the authenticated account where it does not. Automatic assignment reads with the runtime key whether `openbot` exists in its own project. Never put the project key in browser environment variables. The Learning settings and inspection endpoints require an OpenBot administrator; settings writes also require same-origin JSON requests (or an explicitly trusted app origin).

The project key supports runtime ingestion, skill delivery, the read-only Inspector Learning projection, and, scoped to its own project, Learning's review routes: listing and reading proposed skills, approving or rejecting one, and starting an analysis. OpenBot calls those only for an OpenBot administrator, from same-origin requests, and records every approval and rejection in its own audit log with that administrator, since Intelligence records the key as the reviewer. Schedules stay in Intelligence's UI, where you sign in with an account authorized for that project.

The admin page reports evidence and published-skill counts, analysis status, and available delivery diagnostics. An Intelligence with no dashboard serves no Inspector projection, so the page reads the container, its proposals and its runs from the review routes instead and leaves out the counts only Inspector has. When Intelligence has Learning switched off, the page says that rather than that Intelligence could not be reached. An unavailable status is displayed as an error with a retry action, not as an empty container. Server errors and project credentials are not exposed in those messages.

## Managed and self-hosted deployments

For managed Intelligence, keep the existing managed API and gateway configuration. Configure the container in its associated project. For an Enterprise self-hosted Intelligence deployment, use its API and gateway endpoints and the same project's key. Install the Intelligence release and migrations that support Automatic Learning, the Inspector Learning endpoint (`GET /api/inspector/learning`), and published skill delivery before assigning a container in OpenBot. Links come from that server's configured web-app origin, so self-hosted administration opens the correct UI; with no web-app origin there are no links, and review happens in OpenBot.

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
