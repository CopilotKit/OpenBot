# Automatic Learning

Open **Admin → Automatic Learning** to choose which Bots contribute completed conversations to a CopilotKit Intelligence Learning container and receive its published skills. Learning is off until an administrator enables it or an operator supplies a default container. OpenBot still starts and chats without Learning configuration.

1. In the same Intelligence project used by OpenBot, create a Learning container. Its stable ID contains 1–64 lowercase letters, digits, and single hyphens (for example, `support-learning`).
2. In OpenBot, enable Learning and enter the default container ID. Leave the default empty to opt in only particular Bots. Each Bot can inherit the default, use another container, or be excluded. Save the settings.
3. Start **new threads** and complete relevant workflows. Chat, channels, scheduled routines, and handoffs use the same server-side settings. An existing thread keeps the first container assignment (including an unassigned first run); changing a Bot mapping does not move or backfill its earlier evidence.
4. Use **Manage Learning in Intelligence**, **View analysis runs**, and **Review skill candidates** on the Learning page. Intelligence collects evidence, runs analysis, and proposes skills. Review the source evidence and publish approved revisions in Intelligence. Neither a scheduled analysis nor enabling Learning automatically approves a skill.
5. Enable skill delivery for that container in Intelligence and start another Bot invocation. Published guidance is loaded into the Bot's governed run. An exact revision pin keeps a specific published revision; leaving it empty follows new publications after the refresh window. A loaded snapshot alone does not prove the model used a skill: inspect its skill tool calls too.

For live voice calls with a Learning-enabled Bot, substantive answers, explanations, recommendations, research, and actions are delegated through the existing `ask_agent` channel run. That selected Bot's AG-UI run and Rich Threads provide the Learning evidence and published guidance. Brief spoken acknowledgments, clarification, and reading or summarizing its returned answer remain audio and are not evidence. The voice session reads participation when it starts: restart the call after changing Learning settings. Neither the skill snapshot nor the Intelligence project key is sent to the realtime voice provider.

Pausing OpenBot Learning preserves its mappings and thread assignments. It stops new OpenBot assignments and delivery. Previously bound threads remain in their Intelligence containers; pause analysis in Intelligence to stop learning from those containers. Delivery uses the current per-Bot policy on fresh invocations. Intelligence's existing evidence, scheduled analysis, publication, and separate delivery controls remain managed there.

## Credentials and permissions

OpenBot reuses its **server-side** `INTELLIGENCE_API_KEY` and `INTELLIGENCE_API_URL`. Never put the project key in browser environment variables. The Learning settings and inspection endpoints require an OpenBot administrator; settings writes also require same-origin JSON requests (or an explicitly trusted app origin).

The project key supports runtime ingestion, skill delivery, and the read-only Inspector Learning projection. It is not a management credential. Review, run, schedule, and publish links open the existing Intelligence UI, where you sign in with an account authorized for that project. OpenBot does not proxy management writes using its project key.

The admin page reports evidence and published-skill counts, analysis status, and available delivery diagnostics. An unavailable status is displayed as an error with a retry action, not as an empty container. Server errors and project credentials are not exposed in those messages.

## Managed and self-hosted deployments

For managed Intelligence, keep the existing managed API and gateway configuration. Configure the container in its associated project. For an Enterprise self-hosted Intelligence deployment, use its API and gateway endpoints and the same project's key. Install the Intelligence release and migrations that support Automatic Learning, the Inspector Learning endpoint (`GET /api/inspector/learning`), and published skill delivery before enabling the feature. Links come from that server's configured web-app origin, so self-hosted administration opens the correct UI.

OpenBot's database migration adds `learning_settings` and `learning_thread_bindings`; run the normal deployment migrations. The settings are read from the database across replicas, and thread assignment is atomic.

Operators may seed an initial default in the API server environment:

```dotenv
CPK_INTELLIGENCE_LEARNING_CONTAINER_ID=support-learning
# Optional opaque published revision ID; omit to follow latest.
CPK_INTELLIGENCE_SKILLS_REVISION=exact-revision-id
```

These are optional defaults, not additional startup requirements. Once an administrator saves settings, those saved settings take precedence, including a saved off state. Helm exposes the defaults as `config.learning.containerId` and `config.learning.revision`. Local development reads them from `.env`; desktop installations can use the Admin page without modifying native configuration. The revision is an opaque ID, not a number to increment or a special `auto` value.

Built-in agents receive published guidance through the CopilotKit runtime. OpenBot's shipped remote agents receive the server-selected, verified skill snapshot for each run; they do not require the Intelligence project key. Bring-your-own remote agents must consume that forwarded context (or configure the framework's supported native adapter) to use delivered guidance; evidence collection alone does not alter a third-party agent's prompt. Keep existing tool grants, boundaries, credentials, and manually authored slash skills in place: learned guidance does not grant tools or replace them.

See the canonical [Automatic Learning guide](https://docs.copilotkit.ai/learning) and [skill delivery guide](https://docs.copilotkit.ai/intelligence/learned-skills) for current deployment requirements and review behavior.
