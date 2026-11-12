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

1. Starts aimock on `127.0.0.1:46400` in **strict replay**, with the fixtures in `e2e/fixtures/`.
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
| Screenshots, one per step | `screenshots/<journey>/NN-<step>.png` |
| Playwright report (traces on failure) | `report/` (`bunx playwright show-report e2e/.artifacts/report`) |
| aimock's log | `logs/aimock.log` |
| Every model request a journey made, matched or not | `logs/<journey>.model-requests.txt` (and `.json`) |
| The stack's logs | `logs/start.log`, `logs/server.log`, `logs/app.log` |

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
the core loop is re-recorded too). Then run `bun run test:e2e` to check the new fixtures replay, and
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
   links to the Vault, where the person adds an OpenAI key (a dummy; aimock answers). Choosing a
   provider in a setup window is OpenBot Desktop's, driven in a later slice.
3. A question to the Personal Assistant, from the home page.
4. The answer renders whole: the text on screen is exactly what the run streamed (the conversation's
   own events), once. One run: one `RUN_STARTED` in the conversation's events, one `run-model` line
   in the server's log, one call to the model.
5. The conversation gets its generated name, which is neither the question nor the answer, and the
   sidebar shows it.

## What is and isn't under aimock

Every model call on this path goes to aimock: `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` point at it
before the server starts, so every client is built against it. On the core loop those are the
Personal Assistant's run (`POST /v1/responses`), the skill chooser and the conversation's name
(`POST /v1/chat/completions`), and the model list (`GET /v1/models`, answered by aimock from its
fixtures). Model capability data from models.dev is switched off.

Not mocked, because they are not model calls: CopilotKit Intelligence (the licence, and the thread
the conversation is stored in, which the run reads its events from), and an app broker if `.env` has
a Composio key. Automatic Learning, which would send conversations to Intelligence's own models, is
not set up for the run (`OPENBOT_LEARNING_AUTO_ASSIGN=false`).
