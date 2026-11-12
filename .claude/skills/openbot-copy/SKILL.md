---
name: openbot-copy
description: The words and the voice for every piece of text a person reads in OpenBot: screen headings and descriptions, buttons, empty states, notices, chat cards, the server's error and refusal messages that reach the browser, and OpenBot Desktop's setup window, Status window and menus. Holds the glossary (Bot, app, admin, OpenBot, and the parts of OpenBot: front end, backend, database) and the style rules. Use when writing or changing any text that is shown to a person, naming a screen, a section, a button or a state, writing an error or refusal message, or reviewing a diff that adds user-facing strings under app/src, server/src, desktop/src or desktop/src-tauri. Don't use for text written for the model (tool descriptions, standing instructions, system prompts), for code comments, or for the docs under docs/.
---

# OpenBot Copy

## When To Use

Any string a person reads: a heading, a description, a button, a placeholder, an empty state, a
notice, a chat card, a server error that the browser shows. Server messages count: a 409 that says
what to do next is read by a person as much as any screen is.

Not text written for the model. Tool descriptions, standing instructions and prompts steer how a Bot
behaves, and changing their wording is a behaviour change with its own review. Not code comments,
and not `docs/`, which has its own register.

## The Glossary

One word for one thing, everywhere a person can see it.

| Say | For | Not |
|---|---|---|
| **Bot**, **Bots** (capitalised) | What a person creates, talks to and gives work to. | agent, coworker, assistant, AI |
| **agent** | Only an outside framework's program, in the places that are about connecting one: "an agent you already run", "AG-UI agent". | Bot, when the thing is a Bot |
| **app** | A service a Bot uses: Gmail, Google Drive, Notion. | connector, integration, plugin |
| **Connections** | The page that lists the apps and accounts every Bot uses as you: the every-Bot page of Apps. On a Bot's page the same thing is the **Apps** row. | connected accounts, linked accounts |
| **connect / disconnect / reconnect** | What a person does to their own account. | link (except GitHub and Slack identity, where "link" is the vendor's own word) |
| **skill** | A named instruction invoked with `/`. | command, prompt |
| **admin** | The person who runs OpenBot for everybody. | administrator, owner, operator |
| **OpenBot** | The product the person is using, and their account with it: "Sign in to OpenBot", "your OpenBot account". | this deployment, the server, the instance, CopilotKit |
| **OpenBot by CopilotKit** | The company, only where it has to be named: the license agreement's name, a legal or privacy line, the one place setup says who makes OpenBot. | CopilotKit alone |
| **turn on / turn off** | An admin switching an app or a feature. | enable / disable (in sentences; a switch may still read "Enabled") |
| **conversation** | A thread with one or more Bots. | channel, chat (in sentences) |
| **front end** | The part of OpenBot a person opens in the browser. | the web app, the UI |
| **backend** | The part of OpenBot that runs the Bots and keeps conversations, memory, learning and Skills. One word, "Backend" at the start of a sentence. | back end, Intelligence, CopilotKit Intelligence, the platform, the stack, cpki |
| **backend dashboard** | The backend's own pages, where Learning and projects are managed. | the Intelligence dashboard |
| **database** | Where OpenBot keeps its data. | Postgres (outside Admin) |
| **the computers Bots work on**, **Bot computer** | Where a Bot browses and works with files. | sandbox, container |

### The eight, Setup and Vault

A person learns one noun, Bot, and eight things a Bot has (`docs/how-openbot-works.md`). Wherever
they are listed they keep this order, and a list leaves out one with nothing to set there rather
than showing an empty row. `app/src/lib/primitives.ts` holds the names, the order and the icons.

| Say | For | Not |
|---|---|---|
| **Conversations** | Where you give a Bot work and it reports back. Not a settings row. | channels, groups, chats |
| **Routines** | Work a Bot starts by itself: what, starts, does, until. One list per Bot. A goal is a routine with an outcome to reach; a check-in is a routine that only tells you. | Goals, Check-ins, Responsibilities (as page or menu names) |
| **Memory** | What a Bot knows about you and your work. | Capabilities |
| **Skills** | What a Bot knows how to do: skills you wrote, taught, or OpenBot proposed. One page per scope. | Learning (as a page), What it can do, Skills and access, Capabilities |
| **Apps** | The services a Bot can reach. Connections is its every-Bot page. | Plugins, What it can do |
| **Computer** | Where a Bot browses, runs commands and keeps files, and the folders on your machine it may use. | Browsers, This computer (as pages) |
| **Approvals** | When a Bot stops and asks you. | Approval rules (as a page) |
| **Activity** | The record of what a Bot did. | Audit |
| **Setup** | A Bot's name and instructions. | |
| **Vault** | Your saved logins and keys. No Bot sees what is in it. | Saved logins, Passwords, Keys, Credentials (as pages) |

The scopes are **this Bot** (the Bot's page), **every Bot** (Settings, and Connections for Apps)
and, in the team edition, **everyone** (Admin). The words in the "Not" column may still appear in a
sentence ("a goal", "a check-in", "your saved logins") and as a label inside a page. They are not
the title of a page, a menu entry, or a row that opens one.
`tests/no-retired-page-names.test.ts` reads every such title.

**Never say Intelligence.** To a person, admins included, it is all OpenBot. Name the part of
OpenBot instead: "The backend is starting.", "Waiting for the backend", "Couldn't reach the
backend. Try again." Name a feature by what it does (Automatic learning, Memory, Skills), and say
"OpenBot proposes skills", not who inside OpenBot does. An env var an admin sets keeps its name
(`INTELLIGENCE_API_URL`); the word on its own does not appear. Logs, comments, code and the operator
docs under `docs/` and `charts/` are not shown to a person and may name it.
`tests/no-intelligence-in-user-copy.test.ts` fails on a shown string that says it.

**OpenBot Desktop's first screen says self-contained.** "This version of OpenBot is fully
self-contained and runs entirely on your computer, including the OpenBot backend." The Account
step after it says only what it is for: "OpenBot needs a free license key. Sign in to get one."
Neither names Intelligence.

**Never "CopilotKit" alone.** Product copy says OpenBot, or "OpenBot by CopilotKit" where the
company has to be named. Addresses (`dashboard.copilotkit.ai`, `github.com/CopilotKit/OpenBot`),
code identifiers, env names, log lines and Copy diagnostics keep their spelling.
tests/no-intelligence-in-user-copy.test.ts and tests/plain-setup-words.test.ts hold every screen to it.

**Admin is allowed exact names.** An admin page may name `COMPOSIO_API_KEY`, OAuth and "deployment",
because the admin is the one who sets them. A page anybody can open may not.

## The Style

1. **Say what happened, then what to do.** "Gmail isn't connected. Connect it to let Bots read your
   mail." Not why the screen is built the way it is.
2. **Use complete sentences for explanations.** Page descriptions, helper text, notices, and empty-state bodies need a subject and a verb, or a direct instruction ("Connect your accounts"). Avoid fragments such as "The apps your Bots use" or "What this Bot can do." Headings, labels, buttons, and short status labels may be fragments.
   **Keep only useful explanation.** State the action, outcome, or constraint the person needs. Remove copy that merely repeats the heading. Use natural sentence lengths; do not chop prose into fragments to meet a word count.
3. **Plain words.** "use", not "hold a grant on". "can't", not "is unable to". Contractions are fine.
4. **No "rather than", no em dashes, no "which is why", no "so that nothing … that may be wrong".**
   These are the marks of text that is explaining itself. Cut the clause or make it its own sentence.
5. **No internals outside Admin.** Composio, OAuth client, credential, token, grant, scope,
   deployment, broker, endpoint: say what the person sees instead ("not set up yet", "your account",
   "this Bot can use it").
6. **Second person.** "Your apps", "you can". The Bot is "it".
7. **Sentence case** for headings and buttons: "New Bot", "Your connections".
8. **Buttons are verbs**: Connect, Request access, Create, Save. A button never says "Click here" or
   "OK" when it does something specific.
9. **Errors**: what failed, in the person's terms, and one next step. "Couldn't load your
   connections. Reload the page." No stack of reasons, no blame.
10. **Empty states** say what will appear and how: "No skills yet. Write one with New skill."

## Before And After

| Before | After |
|---|---|
| The apps and accounts your Bots use as you. Open one to connect it or change it. | Connect your accounts so Bots can use apps on your behalf. |
| Your connected accounts could not be loaded, so nothing is listed here rather than a list that may be wrong. Reload the page, and tell an administrator if it persists. | Couldn't load your connections. Reload the page, or ask an admin if it keeps happening. |
| Sent to the coworker it is for. Type @ to choose one yourself. | OpenBot picks the right Bot. Type @ to choose one. |
| Gmail is a Composio app, and this deployment has no Composio key. (to a non-admin) | Gmail isn't set up yet. An admin has to turn it on. |
| The agent is still working on another request. Please wait or stop that task first. | This Bot is still working on something. Wait for it, or stop it first. |

## Red Flags

| Signal | Do instead |
|---|---|
| "agent" or "coworker" for a Bot | Bot |
| "administrator" | admin |
| "this deployment" on a page anybody can open | OpenBot, or say what is missing |
| "CopilotKit" alone: "Sign in to CopilotKit", "your CopilotKit account" | OpenBot, or "OpenBot by CopilotKit" where the company must be named |
| A sentence over ~25 words | Split it, or cut the clause that justifies the screen |
| "rather than", an em dash, "which is" in UI text | Rewrite as two short sentences |
| A description beginning "The apps…", "What…", "Who…", or "Where…" without a main verb | State the action or behavior in a complete sentence; remove redundant explanation |
| An env var, OAuth, Composio or "grant" outside Admin | Say what the person sees |
| "Intelligence", "CopilotKit Intelligence" or "the Intelligence stack" anywhere | Name the part: the backend, the front end, the database |
| A test asserting long explanatory copy | Assert the short sentence, or the role and the key words |
| "CopilotKit Intelligence" on OpenBot Desktop's Account step | Allowed there only, in the one lede `SHOWN_BY_DECISION` lists (above) |
