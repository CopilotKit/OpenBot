# End-to-end tests

The real OpenBot, in a real browser, against a real local stack, as a person uses it. Every model
call OpenBot makes is answered by [aimock](https://aimock.copilotkit.dev) from recorded fixtures,
so a run is the same every time, needs no model key and costs nothing.

These run on a developer's machine, not in GitHub: the machine already has the licence, the keys in
`.env`, and Docker or Podman.

## Run

```sh
bunx playwright install chromium   # once
bun run test:e2e
```

Needs `.env` with the Intelligence licence (`CPK_INTELLIGENCE_API_KEY` or `INTELLIGENCE_API_KEY`),
as `scripts/start.sh` does. No model key is used in replay. The first run on a machine builds the
server and computer images, which takes several minutes; after that a run takes under a minute.

What it does:

1. Starts aimock on `127.0.0.1:46400` in **strict replay**, with the fixtures in `e2e/fixtures/`,
   and the Composio stub on `127.0.0.1:46410` (see below).
2. Brings up **its own, fresh stack** with `scripts/start.sh`: the personal edition (one person, no
   sign-in, the Personal Assistant) in the compose project `openbot-e2e`, on ports 46xxx, with a new
   database every run. It never reuses or touches a stack you already have running (OpenBot Desktop,
   a dev stack on 3001/3010, another worktree), builds its images under their own tags, and writes
   its logs to `e2e/.artifacts/logs/` rather than `.logs/`. Every setting it makes is in
   `harness/stack.ts`; your `.env` supplies only the rest (the licence, the encryption key).
3. Runs the journeys in Chromium, then stops the stack.

The app under test is at `http://127.0.0.1:46010`. Set `E2E_KEEP_STACK=1` to leave it running after
the run to look around; the next run replaces it either way.

Results, all gitignored, in `e2e/.artifacts/`:

| What | Where |
| --- | --- |
| Screenshots, one per step, numbered on across a journey's tests | `screenshots/<journey>/NN-<step>.png` |
| Playwright report (traces on failure) | `report/` (`bunx playwright show-report e2e/.artifacts/report`) |
| aimock's log | `logs/aimock.log` |
| Every model request a journey made, matched or not | `logs/<journey>.model-requests.txt` (and `.json`) |
| The stack's logs | `logs/start.log`, `logs/server.log`, `logs/app.log` |
| Every request the Composio stub answered | `logs/composio-stub.log` |

**Look at every screenshot.** A journey that passes with a broken layout has found a bug: overlap,
clipping, a misaligned row, wrong copy, an empty panel. Fix it like any other failure.

## Strict replay

A model request that no fixture answers fails the test that made it, naming the request (endpoint,
model and the last thing said to the model). aimock runs strict and never proxy-only, so a miss can't
quietly reach a real provider. After a run, this must print 0:

```sh
grep -c -E "NO FIXTURE MATCH|STRICT:" e2e/.artifacts/logs/aimock.log
```

## Record

```sh
bun run test:e2e:record
```

Runs the journeys with aimock in record mode and no fixtures loaded: every model request goes to the
real provider with the key in `.env`, and the answer is saved as a fixture under the journey that made
it. The key goes to aimock alone (`harness/aimock-server.ts` reads it by name), never to OpenBot,
which only ever holds an `sk-aimock-` dummy key that aimock swaps on the way out. It is never on a
command line, in a log or in a fixture; a recording that contains it is deleted and the test fails.

Every journey in the run is re-recorded, including the ones it depends on (`--grep` one journey and
the core loop is re-recorded too; put back what you didn't mean to change with
`git checkout -- e2e/fixtures/core-loop`). A journey's fixtures are cleared once, on its first test,
so every test in the file keeps what it recorded. Then run `bun run test:e2e` to check the new fixtures replay, and
read the fixture diff before committing: fixtures hold no keys and no personal data (journeys use
made-up names). Re-record when a journey's words or OpenBot's prompts change.

## How fixtures are scoped

- One directory per journey, `e2e/fixtures/<journey>/`, named after `journeys/<journey>.journey.ts`.
  Recording replaces it.
- A fixture matches on the last user message, the model and the turn (`turnIndex`, `hasToolResult`),
  which is what aimock's recorder writes. Each journey says things no other journey says, so its
  fixtures answer only it. A fixture whose answer holds tool calls matches `hasToolResult: false`, or
  it fires again on the turn after the tool result.
- **Matching is exact, not by substring.** OpenBot quotes the person's words in its own calls (the
  skill chooser, the conversation's name), and by substring the Bot's own fixture answered them too:
  a conversation was "named" with the Bot's reply. `harness/aimock-server.ts` sets aimock's
  `requestTransform`, which switches it to exact matching.
- **One normalisation:** the conversation-naming call quotes the answer only if Intelligence has
  stored it by the time OpenBot's 10 s naming loop runs. The answer is cut from that call before
  matching and recording, so its fixture is keyed on `Asked: <the question>` either way.
- `hasToolResult`, never `sequenceIndex`: sequence counters are global to the aimock process and break
  when journeys run together.
- Fixtures are recorded from the real product, never written by hand: OpenBot and the CopilotKit
  runtime add structure to every request that a hand-written fixture gets wrong.
- OpenBot's model list comes from aimock, which lists the models the fixtures name, so in replay the
  composer offers one model (gpt-5.6-terra) and no model picker. A journey about the model picker
  needs fixtures that name more than one model.
- **A tool call that names a record by its id can't be replayed.** A recorded fixture holds the id
  the record had in the recording run; the one a replay makes has another. Changing a routine by
  asking a Bot (`update_routine`) is one: replayed, the change is refused while the replayed answer
  says it was made. Keep such a step out of a journey rather than assert half of it.

## Add a journey

1. Create `e2e/journeys/<name>.journey.ts`:

   ```ts
   import { expect, test } from "../harness/test";

   test("a person renames a conversation", async ({ page, shot }) => {
     await page.goto("/");
     await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
     await shot("home");
   });
   ```

   It runs in the `journeys` project, after the core loop, on a stack where a person (Sam Rivera)
   has been through first-run setup and has an AI key. Use words in its messages that no other
   journey uses.
2. `bun run test:e2e:record -- --grep "renames a conversation"` records its fixtures into
   `e2e/fixtures/<name>/`.
3. `bun run test:e2e` twice: it passes both times, and the grep above prints 0.
4. Read every screenshot it took.

Write it the way [Playwright recommends](https://playwright.dev/docs/best-practices): locate by role
and accessible name (`getByRole`, `getByLabel`), assert with web-first assertions
(`await expect(locator).toBeVisible()`, `expect.poll` for the API), never `waitForTimeout`, and test
what a person sees. Wait for an animation to finish by asserting on what it leaves behind (the
previous step's heading gone), not by sleeping.

## The core loop

`journeys/core-loop.journey.ts`, the first journey, on a fresh stack:

1. First-run setup: Welcome, OpenBot for Business (Not now), the person's name.
2. The AI connection, as the web app offers it: Settings, Setup says the AI model needs a key and
   links to the Vault's Add key form, where the person pastes an OpenAI key (a dummy; aimock
   answers) and types nothing else: the form starts on the provider the Personal Assistant runs on,
   and the key is filed under the name it reads. Choosing a provider in a setup window is OpenBot
   Desktop's, driven in a later slice.
3. A question to the Personal Assistant, from the home page.
4. The answer renders whole: the text on screen is exactly what the run streamed (the conversation's
   own events), once. One run: one `RUN_STARTED` in the conversation's events, one `run-model` line
   in the server's log, one call to the model.
5. The conversation gets its generated name, which is neither the question nor the answer, and the
   sidebar shows it.

## The Bot's computer and approvals

The `computer-*` and `approvals-*` journeys:

| Journey | What a person does |
| --- | --- |
| `computer-browse` | Asks a Bot to read a page. The Computer opens on its live screen; the answer comes from the page; Activity lists the page with its time, and still does after a reload; the conversation folds the browsing into one line that opens to its steps. |
| `computer-take-control` | Opens the Bot's screen full size, takes control, goes somewhere from the address bar, back, forward, reload, opens a tab and closes it, is asked before clearing the browser, and hands it back. Stops and resets the Bot's browser in Settings → Computer. |
| `computer-terminal` | Asks a Bot to run a command: Activity shows it with what it printed. Takes control of the Terminal, types a command, hands it back. |
| `computer-form` | Asks a Bot to fill in and send a form from one message, its fields and checkbox in one step: every action runs, the form arrives filled in, and Activity lists each with its time. |
| `computer-sign-in` | A Bot reaches a password field and hands it over (no standing answer offered). The person takes control, types the password into the Bot's screen, hands back and answers "I did it myself"; the Bot carries on from the signed-in page. |
| `approvals-allow-once` | A Bot paying asks first. Allow once places that order and the reply arrives whole; the next order asks again, and waits on the Bots page under Needs you too; Deny there places nothing and the Bot says so. |
| `approvals-this-conversation` | Allow for this conversation: the next order there goes through with no card, the banner says what is allowed, Turn off makes the next order ask again. |
| `approvals-always` | Always allow here: the Bot pays without asking in its next conversation; the rule is on the Bot's Approvals page, where Remove takes it away. |
| `approvals-settings` | Settings → Approvals: Extra vigilant, Auto-review and commands on this computer, kept across a reload; a rule for every Bot added, changed, removed, and cancelled. |

Two things they do that other journeys may want to copy:

- **The run's own website.** The pages a Bot reads, the form it fills in and the checkout it pays at
  are `e2e/site/site.ts`, served on `127.0.0.1:46600` while such a journey runs, never a third-party
  site. The Bot's browser, in the computer's container, reaches it at
  `http://host.docker.internal:46600` (Docker Desktop carries that to this machine's loopback). The
  port is fixed whatever `E2E_PORT_OFFSET` says, because the address is in what the person types and
  so in every fixture. The site counts the orders placed and the forms sent, so a journey checks what
  the Bot did, not only what it said.
- **A Bot of its own for each journey** (`makeBot`, a fixture in `journeys/computer-steps.ts`), made
  through the API as setup and deleted when the journey ends, pass or fail. A Bot's browser numbers
  its page snapshots from its first, and a recorded click carries that number: on a Bot another
  journey had browsed with, it would be out of date. A new Bot's browser starts from the beginning
  whichever journeys ran first, an answer or a rule one journey gives stays with its Bot, and the
  journeys after it see only the Bots they expect.

A reply is waited for by what it says (`replyAfter` in `journeys/computer-steps.ts`): a turn that
uses the computer is several runs, and between two of them the last one has finished with a sentence
like "I'm opening the page". It is then checked on screen word for word, once, as the Markdown renders.
Each conversation is also waited for until it has its name, so the naming call is made, and recorded,
inside the journey that caused it.

## What is and isn't under aimock

Every model call on this path goes to aimock: `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` point at it
before the server starts, so every client is built against it. On the core loop those are the
Personal Assistant's run (`POST /v1/responses`), the skill chooser and the conversation's name
(`POST /v1/chat/completions`), and the model list (`GET /v1/models`, answered by aimock from its
fixtures). Model capability data from models.dev is switched off.

Not mocked, because they are not model calls: CopilotKit Intelligence (the licence, and the thread
the conversation is stored in, which the run reads its events from). Automatic Learning, which would
send conversations to Intelligence's own models, is not set up for the run
(`OPENBOT_LEARNING_AUTO_ASSIGN=false`).

## Composio, and an MCP server of the run's own

**Composio is the stub's** (`harness/composio-stub.ts`, started like aimock, before the stack).
OpenBot's Composio client reads `COMPOSIO_BASE_URL`, which `harness/stack.ts` points at the stub, and
holds a dummy key; your `.env`'s Composio key is never used and no real Composio project is touched.
The stub answers the endpoints OpenBot was seen calling on the real API (v3.1: toolkits, tools, auth
configs, connected accounts and their connect links) in the real answers' shapes; its catalogue,
`stubs/composio-catalogue.json`, is eight real apps with four of their real tools each. A connect link
opens the stub's own page for the app's consent screen: Allow marks the account active and returns
to OpenBot with `status=success`, as Composio's hosted page does, so a journey goes past the hand-off
to a connected app without any third-party sign-in. A request the stub has no answer for gets a 501
and is kept in its journal (`GET /__stub/journal`), which the Connections journey checks is clean.

**An MCP server to add by its address** is aimock's (`MCPMock`, mounted at
`MCP_SERVER_URL`: `http://127.0.0.1:46400/mcp/field-notes`). OpenBot refuses a plain-http or
loopback server unless `OPENBOT_ALLOW_LOOPBACK_MCP=1`, which the stack sets for tests. Its requests
are not model requests, so the strict-replay check leaves them out.

## Apps, routines and settings

| Journey | What a person does |
| --- | --- |
| `connections` | Searches Connections and Browse apps; adds Gmail (its sign-in opens in a new tab, OpenBot stays put and waits), closes the tab, connects again and allows; sees it connected in Browse apps and Your apps, its page and tools; disconnects; turns it off. Adds an MCP server by address (refused over plain http first), sees its tools, turns it off. |
| `routines` | New routine with every field (Bot, what to do, act or only tell, each kind of start, when, posts in, name, and what's missing on an empty Create); its page; pause and resume; Run now, which succeeds with nothing left saying it runs, and the answer in its conversation; Delete, asked first. |
| `routine-kinds` | A goal (a routine with Done when): its page, paused, completed, deleted. A goal started by an event. A check-in (Only tell you): how often, switched off, removed. |
| `settings` | General (name, standing instructions, dark theme, skin, sidebar emphasis, shortcuts and the command palette, and no Privacy section outside OpenBot Desktop), Notifications, Vault (a connector key added, replaced and revoked), Computer, Approvals (both switches, commands on your computer, a rule added, changed and removed), Activity (views, search, sort, filters, refresh, CSV export), Setup and Check again, the Components gallery. |
| `skills` | Writes a skill (what's missing said first), turns it off and on for a Bot, changes it, deletes it; review of new skills on and off; Teach a Bot opened from Skills. |
| `vault-model-key` | With no model key, adds one from Setup's link: the form starts on the provider the Bots run on, says when they won't use a key, and files it where they read it; Setup then says the key is set. |

Each puts back what it changed (a name, standing instructions, a rule, an app, a routine and its
conversation), because the next journey's model calls read them.

A test marked `test.fail` is a product bug the suite has found and pins until it is fixed: it fails
today, at the assertion of what should happen, and the marker comes off with the fix.
