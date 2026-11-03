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
| Ask before acting | On for anybody who has not chosen otherwise |
| Stop idle computers | Never: there is one |
| Check-ins per Bot per day | 24, as in the team edition |
| SSO, action recording, model and MCP allowlists, skill sharing | Off |

The password manager uses a saved login only after the person picks it in the private sign-in
form, and taking over the browser is always offered.

## What the app shows

There is no Admin. Apps live on **Connections**, because adding an app and connecting your account
are the same decision when one person makes both:

- `/connections` lists the apps you have, the apps you can add, and the broker directory.
- `/connections/<app>` is the whole app: **Connect** turns it on and goes straight to signing in
  to your account, then its tools and which Bots use them are on the same page.
- When an app is connected, every tool it newly lists that only reads is given to every Bot, so it
  works straight away. Tools that change things are left for you to give, and a Bot still asks
  before it uses one. Tools you take away are not given back when the app is refreshed. See
  `server/src/plugins/personal-defaults.ts`.

The rest of what a person running OpenBot for themselves needs is under Settings: Skills for every
Bot, Credentials, Computer and Activity (the audit trail). Where Admin was, **Team features** opens
a list of what the team edition adds. An old `/admin/...` or `/settings/plugins/...` address opens
the same page under Connections or Settings, or Settings itself. Settings has no Learning page,
which chooses who else's Bots use your Skills, and a Bot has no Sharing page.

The server answers `404` for the API behind the team-only screens: people, identity providers,
enterprise controls (except `/api/admin/enterprise/me`, which any page may ask), the admin learning
and check-in settings, and SCIM and SSO registration. See `server/src/edition-routes.ts`.
