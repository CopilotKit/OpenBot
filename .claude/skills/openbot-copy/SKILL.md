---
name: openbot-copy
description: The words and the voice for every piece of text a person reads in OpenBot — screen headings and descriptions, buttons, empty states, notices, chat cards, and the server's error and refusal messages that reach the browser. Holds the glossary (Bot, app, admin, OpenBot) and the style rules. Use when writing or changing any text that is shown to a person, naming a screen, a section, a button or a state, writing an error or refusal message, or reviewing a diff that adds user-facing strings under app/src or server/src. Don't use for text written for the model (tool descriptions, standing instructions, system prompts), for code comments, or for the docs under docs/.
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
| **app** | A service a Bot uses: Gmail, Google Drive, Notion. | connector, integration, plugin (outside Admin) |
| **Connections** | The apps and accounts a Bot uses as you, and the page that lists them. | connected accounts, linked accounts |
| **connect / disconnect / reconnect** | What a person does to their own account. | link (except GitHub and Slack identity, where "link" is the vendor's own word) |
| **Capabilities** | Your skills and your Bots' memory of you, and the page with both. | plugins |
| **skill** | A named instruction invoked with `/`. | command, prompt |
| **admin** | The person who runs OpenBot for everybody. | administrator, owner, operator |
| **OpenBot** | The product the person is using. | this deployment, the server, the instance |
| **turn on / turn off** | An admin switching an app or a feature. | enable / disable (in sentences; a switch may still read "Enabled") |
| **conversation** | A thread with one or more Bots. | channel, chat (in sentences) |

**Admin is allowed exact names.** An admin page may name `COMPOSIO_API_KEY`, OAuth and "deployment",
because the admin is the one who sets them. A page anybody can open may not.

## The Style

1. **Say what happened, then what to do.** "Gmail isn't connected. Connect it to let Bots read your
   mail." Not why the screen is built the way it is.
2. **One idea per sentence. Short sentences.** A description is one or two sentences, about 20 words.
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
| A sentence over ~25 words | Split it, or cut the clause that justifies the screen |
| "rather than", an em dash, "which is" in UI text | Rewrite as two short sentences |
| An env var, OAuth, Composio or "grant" outside Admin | Say what the person sees |
| A test asserting long explanatory copy | Assert the short sentence, or the role and the key words |
