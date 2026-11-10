# Personal edition

`OPENBOT_EDITION=personal` runs OpenBot for one person on their own machine: nobody signs in, there
is one computer, and the deployment starts with a single Bot, the Personal Assistant. Unset, or
`team`, is OpenBot as an organization runs it, unchanged.

## Set it up

```sh
bash scripts/use-personal-edition.sh
```

That writes the settings in `.env.personal.example` into `.env` (starting from `.env.example` when
there is no `.env`), replacing any line for the same key. Then fill in `OPENAI_API_KEY` (or the key
for your `BOT_PROVIDER`) and the Intelligence settings, and start it:

```sh
bash scripts/start.sh
```

`start.sh` reads the edition from `.env`: it starts the one shared computer and no Bot containers,
because the Personal Assistant runs inside the server on the model in
[`examples/personal/model.yaml`](../examples/personal/model.yaml).

It also starts your own browser: your installed Google Chrome, or Microsoft Edge, as a window on
your desktop with the OpenBot Recorder in it. It builds the Recorder (`extension/dist`) if it isn't
built, runs `scripts/start-local-chrome-computer.ts` on port `BROWSER_PORT` (4101) with
`COMPUTER_PEOPLE_ONLY=on`, and points the server at it with `OPENBOT_BROWSER_URL`. **Teach a Bot**
in the sidebar takes you to a page whose Open opens or brings forward that window, and Record there
goes to your own Learning space. OpenBot Desktop does not do this: it shows your browser inside its
window (see [OpenBot Desktop](#openbot-desktop)). Its profile is kept under
`~/Library/Application Support/OpenBot/local-computer` on macOS (see
[configuration](configuration.md#installed-chrome-for-a-local-api-deployment) for the other systems).
Without Chrome or Edge, OpenBot starts without it and `start.sh` says why. `scripts/stop.sh` stops it
with the rest.

## OpenBot Desktop

OpenBot Desktop installs the personal edition: it writes `OPENBOT_EDITION=personal` and the settings
below into its deployment's `.env` on every Start (`desktop/src-tauri/src/env.rs`). It runs
PostgreSQL, the one computer, the server and the worker, and no supervisor and no bundled Bot
containers.

The server's container is given the supervisor by name in `docker-compose.yml` unless
`COMPUTER_SUPERVISOR_CONTAINER_URL` is set, so the desktop sets it empty as well as
`COMPUTER_SUPERVISOR_URL`.

A new installation starts with one Bot, the Personal Assistant. When a Bot was picked during setup,
the Personal Assistant runs on what was picked: it takes the `picked-harness` row's id and
connection, and the Personal Assistant's instructions, skills and conversation, and its subtitle
says what runs it ("Everyday life. Powered by LangChain.", which its profile shows as "Everyday life
agent. (powered by a LangChain agent; you can bring your own agent from any stack.)"). With nothing
picked, as
`start.sh` leaves it, `PICKED_HARNESS_URL` is empty, the `picked-harness` row in
[`examples/personal/agents.yaml`](../examples/personal/agents.yaml) is dropped, and the Personal
Assistant runs inside the server ("Everyday life. Powered by OpenBot."). Either way it is an
ordinary Bot: its name, subtitle and instructions can be changed on its Setup page. On OpenBot
Desktop, after a change of AI provider, Start moves it to the new framework, renamed or not, and
rewrites the "Powered by" part of its subtitle, keeping any words around it. A connection the person
set on the Setup page is left alone.

The starter is seeded once, into a new installation only (`personalStarterSeed` in
`server/src/tenant-package.ts`). An existing installation keeps the Bots it has: where the Personal
Assistant and the picked Bot are two Bots, they stay two, and neither is rewritten from the package
on Start. Only the picked Bot's connection still follows the installer.

**Teach a Bot** shows your browser inside the OpenBot window, as hosted OpenBot does: its tabs, its
address bar and the live page, with the Recorder already in it and Record and Stop in OpenBot. It
runs on the one computer, beside your Bots (see [Teach a Bot](#teach-a-bot) below); no separate
Chrome window opens. Narration comes from the OpenBot window, as on hosted OpenBot. The window's web
view has no speech recognition that stays on your computer, so the desktop app does it instead: Apple's
Speech framework with on-device recognition required on macOS, the in-process SAPI recognizer on
Windows. Your voice never leaves the machine; where neither can recognise your language, narration is
off. macOS asks once for speech recognition and the microphone. The desktop runs
no browser of its own on your machine, and writes no `OPENBOT_BROWSER_URL`; Start takes out one an
earlier version wrote.

The Recorder reaches OpenBot only at an https address or at this machine's loopback, so the browser
in the computer's container is handed `http://127.0.0.1:<port>`, which in there is the container.
The desktop writes `COMPUTER_LOOPBACK_RELAYS` (`<port>=<host>:<port>`, comma-separated): the app's
and the server's ports to the server's container, and a local Intelligence gateway's port to
`host.docker.internal`. The computer listens on those ports at its own loopback and passes each
connection on (`agent-computer/src/loopback-relay.ts`). Unset, it relays nothing.

An installation from an earlier OpenBot Desktop, which ran the team edition, becomes the personal
edition on its next Start. Its Bots and conversations stay in the database. The team edition's
settings stored there are not read (see [What is fixed](#what-is-fixed)). The package keeps the
`openbot` tenant id so the picked Bot retains its package ownership across that switch. It was
`personal` up to v0.3.1, and lists that as a former id, so a personal edition set up with
`start.sh` then keeps its Bots, conversations and deployment name. Stop still stops each
computer the supervisor made for a Bot.

Its Bots' files and browser logins come along. The supervisor gave the person a computer of their
own, whose volumes keep each Bot's files in `computers/<bot>` and its browser profile in `<bot>`; the
one computer keeps them in `computers/<person>~<bot>` and `<person>~<bot>`. Start copies each Bot's
files and profile from the old volumes into the new places, with their owners and modes, once
(recorded in `.openbot-carried-over/` in each new volume), in a short-lived container from the
computer's own image (`stack::carry_over_person_computers`). Nothing already there is replaced: a
Bot's files are merged into its folder, and a profile the one computer already has for that Bot is
kept whole, as the supervisor's own carry-over does. The old volumes are left as they were.

## What the server requires

The server refuses to start in the personal edition unless all of these hold, and says which
variable to change:

| Requirement | Why |
| --- | --- |
| `OPENBOT_SINGLE_USER=true` | Nobody signs in. Single-user mode is still refused on a public address. |
| No `GOOGLE_OAUTH_*`, `MICROSOFT_OAUTH_*`, `OKTA_OAUTH_*` or `OPENBOT_ORGANIZATION_AUTH_URL` | There is no sign-in to configure. |
| `AGENT_COMPUTER_URL` set, and no `COMPUTER_SUPERVISOR_URL` or `COMPUTER_SANDBOX_NAMESPACE` | One computer, shared by every Bot. |

## What is fixed

Settings an admin changes in the team edition are fixed here. Values left in the database by a team
deployment are not read: capability switches, enterprise settings, network policies, team approval
settings and team rules, and a paused Automatic Learning. Every Bot takes part in Automatic
Learning: a Bot those settings left out is taken back in at the next start, or its first run.

| | Personal edition |
| --- | --- |
| Use Bots, cloud browser, network and computer, local computer access (folders, in OpenBot Desktop), custom rules, password manager, apps a Bot uses as you, check-ins | On |
| Slack and Teams, Team Bots, Isolated Bots | Off |
| Extra vigilant | Off for anybody who has not chosen otherwise. Paying, and deleting, sending, sharing or posting in your apps and on websites, ask anyway, as does every edit or command in a folder on this computer. A Bot's own computer is its scratch space. See [Approvals](approvals.md) |
| Stop idle computers | Never: there is one |
| Check-ins per Bot per day | 24, as in the team edition |
| SSO, action recording, model and MCP allowlists, skill sharing | Off |

The password manager uses a saved login only after the person picks it in the private sign-in
form, and taking over the browser is always offered.

### Folders on this computer

In OpenBot Desktop, Settings → Computer → **Folders on this computer** lets a Bot use folders on
your own machine. Every safeguard the team edition has applies here too:

- You pick each folder in the desktop's own folder picker (**Choose folder** on the Bot's row). A
  Bot sees only the folders picked for it.
- A folder is read-only. Before a Bot changes a file or runs a command in it, the desktop app asks
  you in a dialog of its own. Set **Commands on your computer** in Settings → Approvals to Never to
  refuse every command.
- Every folder chosen, every file read or changed and every command is in Activity.
- Access ends when OpenBot stops, when the desktop app goes offline, or when you press **Revoke** or
  **Stop folder access**. Nothing is remembered across a restart.

Only the desktop can open a folder. It hands the server a token minted on every Start
(`OPENBOT_DESKTOP_HOST_TOKEN`), and its folder worker answers the server with it. A personal edition
started with `scripts/start.sh` has no such token, so the section says it needs OpenBot Desktop and
offers no picker, and the server refuses a folder request at once (`409`) rather than waiting for a
desktop that will never answer. See `server/src/host-access/` and
`desktop/src-tauri/src/desktop_host_access.rs`.

### Teach a Bot

You can also teach a Bot a task in its own browser: take control of it and press **Record**. The recording goes to your
own Learning space. The team edition refuses Record on a computer its Bots share, because another
Bot's shell could read the Recorder's connection there. Here every Bot on the one computer is yours,
so `scripts/start.sh` and the desktop start it as yours (`COMPUTER_PERSON_ID`) and the server allows
Record.

For the same reason your own browser (**Teach a Bot**) may run on that computer here, where the team
edition refuses it: the one computer is told the edition (`OPENBOT_EDITION`, beside
`COMPUTER_PERSON_ID`), and the server and the computer both allow it only in the personal edition. Its
profile sits beside your Bots' profiles, which already hold the sites you signed in to for them.
Where `OPENBOT_BROWSER_URL` is set, as `scripts/start.sh` sets it, your browser runs there instead.

## What the app shows

The menu is **Bots**, **Connections** and **Settings**. There is no Admin and no Capabilities page.

**Connections** is every way a Bot signs in to something, because adding an app and connecting your
account are the same decision when one person makes both:

- `/connections` is one searchable grid of the apps that connect in one press, plus your GitHub
  account, connected ones first. **Connect** adds the app and goes straight to signing in; **Add**,
  for an app with no account (a free search provider), turns it on. Apps that need a key or an OAuth
  client typed first wait behind **Show apps that need setup**, and a search finds them too. With a
  broker set up, the last tile browses its directory of more apps.
- Connecting an app gives **every Bot every tool** it lists, including the ones that change things.
  Ordinary changes just happen. Deleting, sending, sharing, posting and paying ask first in the
  conversation, where you can allow each once, for the conversation, or always. Turn on **Ask before
  making changes** in Settings → Approvals to be asked about every change. See
  [Approvals](approvals.md). An app can't be taken from one Bot; turning it off takes it from all of
  them. See `server/src/plugins/personal-defaults.ts`.
- A connected tile opens `/connections/<app>`: its tools, your account, and turning it off.
- **Sign-ins and keys**, below the grid, links to saved website logins and API keys, which live under
  Settings.
- **Routines is always on**, here as in the team edition: every Bot has all of its tools, and it
  can't be turned off. See [Routines](routines.md).
- **Parallel Search is on from the start**, and can be turned off. See
  [Web search is on from the start](#web-search-is-on-from-the-start).

**In a conversation**, when a Bot needs an app that isn't connected, it shows a card. For an app
you sign in to, **Connect** turns the app on and opens its sign-in in a new tab, and the
conversation carries on once it is connected. An app with nothing to sign in to, or whose sign-in
isn't known until it is on, shows **Turn on**, and one that takes a key shows **Set up**, which
opens its page under Connections. The Bot is told which button the card shows, so it names that one
(`server/src/plugins/app-access-tool.ts`).

**Bots** lists your Bots and, under **What your Bots know**, Skills and Memory. A Bot's own page has
four settings: Routines, Memory, **What it can do** (the apps and skills it has, what it asks before
doing, and its goals) and Setup.

**Settings** holds Saved logins, Keys, Skills for every Bot, Learning, Computer and Activity (the audit trail).
Where Admin was, **OpenBot for Business** opens a list of what the team edition adds. An old
`/admin/...` or `/settings/plugins/...` address opens the same page where it is now. There is no Sharing, Visibility, Isolated, or Reaching you, which are
all about other people, other computers or Slack and Teams.

**Settings → Learning** is where the skills OpenBot learns from your recordings and conversations
wait for your review. You approve or reject them yourself, under **Waiting for your review**, and
**Learn now** starts a run on demand. **Your skills** lists the skills learned from your recordings and conversations,
and a row opens one to read. A skill from your recordings reaches every Bot. A skill from
conversations reaches the Bots that share its Learning container, which is every Bot unless one
has a container of its own. There is no one to share with, so **Ask to share** is not offered here.

**Approve new skills automatically** is on from the start, so you don't have to review each one. It
approves what OpenBot proposes from your recordings and conversations. It runs when Learning opens,
every 15 minutes, and when you switch it on. Turn it off in Settings → Learning to review each skill
yourself. **Your recordings** on Teach a Bot lists what you have recorded, which needs Intelligence
0.16 with recordings switched on. Recordings can't be deleted from OpenBot.

The server answers `404` for the API behind the team-only screens: people, identity providers,
enterprise controls (except `/api/admin/enterprise/me`, which any page may ask), the admin learning
and check-in settings, and SCIM and SSO registration. See `server/src/edition-routes.ts`.

## Web search is on from the start

The first time the server starts, it turns on **Parallel Search**, Parallel's free web search that
needs no key, so every Bot can search the web and read pages with nothing set up. Every Bot gets its
`web_search` and `web_fetch` tools, including Bots made later.

What a Bot searches for goes to Parallel: the search queries and the addresses of the pages it asks
to read, and a session identifier for the conversation. Full conversations are not sent. See
[Public-web research](web-research.md#choice-and-controls).

It is turned on once. Turn it off on its Connections page and it stays off: the server writes down
that it turned it on (`personal_default_apps` in `enterprise_settings`) and never does it again.
Starting offline doesn't stop the server. Parallel is turned on without its tools, and the server
asks for them again in the background, and on every start, until Parallel answers, so nobody has to
press Refresh. See `ensurePersonalDefaultApps` in `server/src/plugins/personal-defaults.ts`.
