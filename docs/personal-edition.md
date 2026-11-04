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

It also starts your own browser, as OpenBot Desktop does for the team edition: your installed Google
Chrome, or Microsoft Edge, as a window on your desktop with the OpenBot Recorder in it. It builds the
Recorder (`extension/dist`) if it isn't built, runs `scripts/start-local-chrome-computer.ts` on port
`BROWSER_PORT` (4101) with `COMPUTER_PEOPLE_ONLY=on`, and points the server at it with
`OPENBOT_BROWSER_URL`. **Teach a Bot** in the sidebar takes you to a page whose Open opens or brings forward that window, and Record
there goes to your own Learning space. Its profile is kept under
`~/Library/Application Support/OpenBot/local-computer` on macOS (see
[configuration](configuration.md#openbot-desktop-runs-it-for-the-person) for the other systems).
Without Chrome or Edge, OpenBot starts without it and `start.sh` says why. `scripts/stop.sh` stops it
with the rest.

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
settings and team rules, and a paused Automatic Learning.

| | Personal edition |
| --- | --- |
| Use Bots, cloud browser, network and computer, custom rules, password manager, apps a Bot uses as you, check-ins | On |
| Local computer access, Slack and Teams, Team Bots, Isolated Bots | Off |
| Ask before making changes | Off for anybody who has not chosen otherwise. Paying, deleting, sending, sharing and posting ask anyway. See [Approvals](approvals.md) |
| Stop idle computers | Never: there is one |
| Check-ins per Bot per day | 24, as in the team edition |
| SSO, action recording, model and MCP allowlists, skill sharing | Off |

The password manager uses a saved login only after the person picks it in the private sign-in
form, and taking over the browser is always offered.

You can also teach a Bot a task in its own browser: take control of it and press **Record**. The recording goes to your
own Learning space. The team edition refuses Record on a computer its Bots share, because another
Bot's shell could read the Recorder's connection there. Here every Bot on the one computer is yours,
so `scripts/start.sh` starts it as yours (`COMPUTER_PERSON_ID`) and the server allows Record. Your
own browser never runs on that computer: it is the window on your desktop above.

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
  Ordinary changes just happen. Deleting, sending, sharing and posting ask first in the
  conversation (Allow once or Deny), and paying or buying is handed to you. Turn on **Ask before
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

**In a conversation**, when a Bot needs an app that isn't connected, it shows a card with
**Connect**: one press turns the app on and opens its sign-in in a new tab, and the conversation
carries on once it is connected.

**Bots** lists your Bots and, under **What your Bots know**, Skills and Memory. A Bot's own page has
four settings: Routines, Memory, **What it can do** (the apps and skills it has, what it asks before
doing, and its goals) and Setup.

**Settings** holds Saved logins, Keys, Skills for every Bot, Computer and Activity (the audit trail).
Where Admin was, **OpenBot for Business** opens a list of what the team edition adds. An old
`/admin/...` or `/settings/plugins/...` address opens the same page where it is now. There is no Learning page, Sharing, Visibility, Isolated, or Reaching you, which are
all about other people, other computers or Slack and Teams.

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
