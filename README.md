# OpenBot

OpenBot is a self-hostable workspace for AI coworkers. Give a Bot a job, connect the tools it needs, and watch it work. You can build a Bot in the workspace or connect an agent you already run.

| How do you want to use OpenBot? | Get started |
| --- | --- |
| **Open-source template.** Clone the MIT-licensed application and make it your own. Change the interface, add agents, and choose which tools they can use. | [Run from source](#quick-start) |
| **Personal Edition.** Run a fully self-contained workspace on your Mac or Windows PC. The desktop app runs OpenBot and its supporting services locally. | [Mac (Apple silicon)](https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-mac-arm64.dmg) · [Mac (Intel)](https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-mac-x64.dmg) · [Windows (x64)](https://github.com/CopilotKit/OpenBot/releases/latest/download/OpenBot-windows-x64-setup.exe) |
| **OpenBot for Business.** Deploy on your infrastructure with Helm or use a workspace hosted by CopilotKit. Both options are in early access. | [Explore Business](https://openbot.co/business) · [Scope a POC](https://www.copilotkit.ai/book/openbot) |

[Watch the walkthrough](https://openbot.co/assets/product/openbot-walkthrough-light.mp4) · [Documentation](docs/README.md) · [OpenBot website](https://openbot.co)

## Try it

Pick a task you know well enough to review. Say a hotel receipt shows a $240 room charge and $30 in tax. The nightly limit is $250. Should Finance flag the claim?

Give your Bot access to the policy in Drive and ask it to check the receipt in the expense portal. If the portal asks for a second factor, take over the browser, sign in, and hand it back. Ask the Bot to show the room rate, tax, and policy limit side by side. You can check its reasoning and decide what to do. The Bot only needs permission to read the policy and receipt for this job.

For work you repeat, use **Teach a Bot** to show it the steps in the browser and save them as a reusable Skill. You can return to the conversation about this claim or use the Skill on a different receipt. With Automatic Learning connected, CopilotKit Intelligence can also propose Skills from completed work. [How Learning works](docs/automatic-learning.md)

## Personal Edition

Download OpenBot for your platform above, open the app, and follow setup to connect your model. Start a conversation with the built-in Personal Assistant. You can connect work accounts as you need them.

The workspace runs on your computer. When you use a hosted model or connect an app such as Drive, OpenBot contacts that provider. Model usage is billed separately by your provider. See the [Personal Edition guide](docs/personal-edition.md) for browser setup, approvals, and personal defaults.

## Quick start

To build on the template, start from a fresh clone. This example uses managed CopilotKit Intelligence and an OpenAI key for the sample Bot. Install Docker, Bun 1.4 or later, and Node.js with `npx`. The start script also uses `lsof`, `openssl`, and `curl`.

```sh
git clone https://github.com/CopilotKit/OpenBot.git
cd OpenBot
cp .env.example .env
bun install

npx --yes copilotkit@latest login
npx --yes copilotkit@latest project select
bun scripts/setup-learning.ts
```

Add your `OPENAI_API_KEY` to `.env`, then start OpenBot:

```sh
bash scripts/start.sh
```

Open [localhost:3010](http://localhost:3010). The example configuration admits local requests as one administrator. Configure sign-in before exposing it to anyone else. Run `bash scripts/stop.sh` to stop the stack and keep your data.

For self-hosted Intelligence, follow the [development setup](docs/development.md#setup). For setup with a coding assistant, use [the setup prompt](prompt.txt).

## Bring your own agent

If you already have a LangGraph agent that checks expenses, keep its prompts, tools, and code where they are. Expose an [AG-UI](https://github.com/ag-ui-protocol/ag-ui) endpoint, open **Bots**, and create a Bot with that endpoint. Add an authorization header if your endpoint needs one. Your team can now work with the agent in OpenBot. The same approach works with Google ADK, the Claude Agent SDK, or a hand-written AG-UI agent. See [coworker configuration](docs/coworkers.md) for endpoint restrictions and access settings.

You can also define Bots in a [tenant package](examples/fintech), grant tools through MCP, and build interactive components for decisions like the expense review. To see how much of the interface you can change, look at [OpenDuet, OpenDots, and OpenMuse](app/src/skins). All three use the same OpenBot backend.

## OpenBot for Business

Teams can share Bots while each person connects their own accounts. An administrator can grant tools to particular Bots, require approval for sensitive actions, and review activity. For the expense workflow, Finance could share one review procedure across the team and reserve payment approval for a person.

- **Your infrastructure (early access).** Use the [Kubernetes Helm chart](charts/openbot/README.md) to deploy OpenBot in your own cloud or data center. The guide covers cluster prerequisites, database setup, and Intelligence credentials.
- **Hosted by CopilotKit (early access).** [Request Business access](https://openbot.co/business) or [book a deployment scoping call](https://www.copilotkit.ai/book/openbot).

## Architecture and licensing

The [OpenBot application source](LICENSE) is MIT-licensed. The workspace connects people to agents through AG-UI. OpenBot checks browser, file, and connected-tool actions against the permissions you grant. CopilotKit Intelligence provides durable conversations, memory, and Learning. Intelligence is separately licensed and can run locally, on your infrastructure, or as a managed service. An OpenBot for Business license includes Intelligence for use with OpenBot. See [plans and pricing](https://openbot.co/pricing) for what's included.

## Documentation

- [Architecture](docs/architecture.md) and [configuration](docs/configuration.md)
- [Docker deployment](docs/deployment.md) and [Kubernetes deployment](charts/openbot/README.md)
- [Approvals](docs/approvals.md), [connected apps](docs/plugins/composio.md), and [scheduled routines](docs/routines.md)
- [Development and checks](docs/development.md) and [all documentation](docs/README.md)

## Contributing

Issues and pull requests are welcome. For substantial changes, open an issue first so we can discuss the approach. Include tests and docs for the behavior you change, and run the [development checks](docs/development.md) before opening a pull request.
