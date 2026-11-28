# OpenBot docs

Start with [How OpenBot works](how-openbot-works.md): what a Bot has, and where you set each part for one Bot, every Bot or everyone. Then the root [README](../README.md), and these references:

- [Architecture](architecture.md): services, ports, browser governance, computers, components, plugins, knowledge, and security boundaries.
- [Configuration](configuration.md): environment variables and tenant package YAML.
- [Personal edition](personal-edition.md): OpenBot for one person, with no sign-in.
- [Development](development.md): local setup, migrations, ports, and quality checks.
- [Don't break the API or the database](api-and-migrations.md): the hard rules every change to the API, an app's requests or the database keeps. Read it first.
- [App guidelines](app-guidelines.md): the one color scheme every app keeps to, what the phone app covers at launch, and the stack it is built with.
- [The API spec](../api/README.md): the REST API in OpenAPI and the live channels in AsyncAPI, the client generated from them, and how to change them.
- [API versions and compatibility](api-versioning.md): what counts as breaking, deprecation, the 12-month support window, minimum app versions, the launcher contract, the security floor, and what CI stops.
- [Bots](coworkers.md): durable Bot profiles, conversations, visibility, deletion, and external AG-UI registration.
- [Connect your agent's framework](agent-frameworks.md): the few lines a LangGraph, Pydantic AI, Mastra, CrewAI, Claude Agent SDK, Agno, CopilotKit, AWS Strands or A2A agent needs so its model is told the Bot's role and tool guidance.
- [Approvals](approvals.md): which actions a Bot asks before, the order that decides it, and what an admin can close.
- [Routines](routines.md): the one list of routines, goals and check-ins, how the server fires them, and who they run as.
- [Automatic Learning](automatic-learning.md): which Bots contribute conversations to a Learning container, and receive its published skills.
- [Public-web research](web-research.md): search and page reading through Parallel, Exa or Firecrawl.
- Plugins, one connector per page — what an administrator registers, what each person consents to, and what the failures mean:
  - [Composio](plugins/composio.md): a broker, and so a catalogue of apps rather than a single connector.
  - [Arcade](plugins/arcade.md): the other broker, and the setup an Arcade project needs that Composio does not.
  - [Google Drive](plugins/google-drive.md)
  - [Notion](plugins/notion.md)
  - [MCP servers added by URL](plugins/mcp-by-url.md)
- [Deployment](deployment.md): the container, what is in the image, minimum sizes, and the platform notes.
- Kubernetes: the two Helm charts published with each release, `openbot-bundle` (OpenBot and Intelligence together, on one PostgreSQL server) and `openbot` (OpenBot alone, pointed at an Intelligence that already runs). Each chart's guide (`helm show readme`) covers what a cluster needs before it and the values that differ per cloud. From the release after v1.1.2, both connect a team install to CopilotKit's management service by default; see [CopilotKit management on Kubernetes](managed-upgrades.md).
- [Releasing](releasing.md): how a release is proposed, reviewed and published.
- [Releases and upstream integration](upstream-upgrades.md): integrating upstream into customer source, kept separate from deploying an accepted release.
- [Explicit local updates](local-updates.md): `bun scripts/update.ts local`, which updates a known source checkout at a maintenance boundary.
- [Kubernetes release promotion](kubernetes-upgrades.md): `bun scripts/update.ts kubernetes`, which promotes a release through the `openbot` Helm chart.
- [CopilotKit management on Kubernetes](managed-upgrades.md): the management agent both charts install by default, exactly what it sends to CopilotKit, how to turn it off, the Admin → Managed updates screen, and how to let CopilotKit run your upgrades.
- [Installer runbook](installer-runbook.md): build an installer, release it, install it on a clean machine, and check that it is the build you meant.
- [Windows desktop signing](windows-signing.md): protected Azure Key Vault signing and verification of the app and NSIS installer.
- [Desktop install](desktop-install.md): the desktop app's setup flow, who owns each step, and the decisions behind it.
- [Desktop updates](desktop-updates.md): how OpenBot Desktop updates itself, and how the installation follows it.
- [Desktop provider OAuth](../desktop/PROVIDER_OAUTH.md): xAI model sign-in and what a distributor configures for it in a desktop build.
- [Desktop telemetry](../desktop/TELEMETRY.md): every event the desktop app sends, and what it carries.
- [Product telemetry](TELEMETRY.md): the server's usage events, what they carry, and how to turn them off, with example PostHog queries in [telemetry-queries.sql](telemetry-queries.sql). It also notes the management connection a Kubernetes team install makes by default.
- [First-use starter tasks](testing/first-use-tour.md): the starter tour offered before a first conversation, and how it was tested.

Do not include credential values, customer data, transcripts, or local-only notes in public docs.
