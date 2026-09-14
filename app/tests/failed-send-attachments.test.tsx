import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  attachmentUrl,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/channels/attachments";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT A FAILED SEND DOES TO THE FILES IT WAS CARRYING, DRIVEN THROUGH THE REAL CHANNEL.
 *
 * The composer suites reach this area through a fake `onSubmit` and `messages={[]}`, which is
 * exactly the state in which deleting a failed send's rows looks harmless: there is no transcript
 * to contradict, so a test can watch the DELETE go out and call it a release. The whole point of
 * this file is that the transcript IS there. `ChannelChat` is what turns a draft into a message —
 * it adds the user turn to `agent.messages` BEFORE the run, so by the time the run fails the
 * screen is already showing a message whose attachments point at those rows — and only a test
 * that goes through it can see the two halves at once.
 *
 * So everything below the HTTP boundary is real: the provider, the agent, `say`/`deliver`, the
 * conversation view's queue, and the composer. Only `fetch` is a fixture, and it is the fixture
 * that decides the two failures under test — a run that answers 503, and an upload that answers
 * with a stored row id.
 *
 * TEXT FILES RATHER THAN THE REVIEWER'S SCREENSHOT, and nothing in the path cares: a staged row is
 * a staged row, `attachmentUrl` addresses both the same way, and the release, the cap and the
 * queue all count them identically. An image tile would additionally ask happy-dom to load an
 * `<img>`, which is a second fixture for a detail this file is not about.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and `settleReactWork()` before the document goes away — see that helper for what a
 * scheduler callback landing after `unregister()` does to an otherwise green run.
 */

const NativeResponse = globalThis.Response;

const channel: AgentChannel = {
  id: "failed-send-channel",
  name: "Failed send",
  agentIds: ["failed-send-bot"],
  threadId: "failed-send-thread",
  active: true,
  lastMessageAt: "2026-09-09T00:00:00.000Z",
};

const opening = {
  id: "opening",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;

/** The run inputs that actually left the browser, in order. */
let runs: RunAgentInput[];
/** Every `DELETE /api/attachments/:id` the screen sent, by path. */
let deletes: string[];
/** Every upload that actually left the browser, by file name. */
let uploads: string[];
/**
 * What each run answers, by the order it was started. A test installs one entry per run it expects;
 * anything past the end finishes normally, so a stray run is visible as an extra entry in `runs`
 * rather than as a hang.
 */
let runAnswers: ((input: RunAgentInput) => Promise<Response>)[];
let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;
let originalFetch: typeof fetch;

function CoreProbe() {
  core = useCopilotKit().copilotkit;
  return null;
}

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function finished(input: RunAgentInput) {
  return sse([
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ]);
}

/** A response this test hands over when it decides to, not when the fixture is called. */
function deferred() {
  let settle: (response: Response) => void = () => {
    throw new Error("Deferred response not initialized");
  };
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (init?.method === "DELETE") {
        deletes.push(url.pathname);
        return new NativeResponse(null, { status: 204 });
      }
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/failed-send-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "failed-send-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [opening] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/run")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(await request.json());
        const answer = runAnswers[runs.length];
        runs.push(body);
        return answer ? await answer(body) : finished(body);
      }
      if (/\/api\/channels\/[^/]+\/attachments$/.test(url.pathname)) {
        const body = init?.body as FormData;
        const file = body.get("file") as File;
        uploads.push(file.name);
        return NativeResponse.json(
          {
            // One stored id per file, derived from its name, so a DELETE can be attributed to the
            // file it was for rather than to "the attachment".
            id: `stored-${file.name}`,
            name: file.name,
            mimeType: "text/plain",
          },
          { status: 201 },
        );
      }
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: [opening] });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});

beforeEach(() => {
  runs = [];
  deletes = [];
  uploads = [];
  runAnswers = [];
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  core = undefined;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function cacheChannel() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: "failed-send-bot",
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-09-09T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}

async function mounted() {
  cacheChannel();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <CoreProbe />
        <ChannelChat channel={channel} runtimeAgentId="failed-send-bot" />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  await view.findByText(opening.content);
  return view;
}

function currentAgent() {
  const agent = core?.getAgent(`channel:${channel.id}`);
  if (!agent) throw new Error("Mounted channel agent is not registered");
  return agent;
}

function form({ container }: RenderResult) {
  return container.querySelector("form") as HTMLFormElement;
}

/** A drop, as the browser delivers one: files hanging off `dataTransfer`. */
function drop(target: Element, files: File[]) {
  fireEvent.drop(target, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

function named(name: string) {
  return new File([name], name, { type: "text/plain" });
}

/**
 * A dropped file, all the way up. See `composer-attachments-ui.test.tsx` for the full note: the
 * chip appears when the upload STARTS, so only the send button coming back on says it has landed.
 */
async function uploaded(view: RenderResult, names: readonly string[]) {
  await waitFor(() => {
    for (const name of names) {
      expect(view.queryByLabelText(`Remove ${name}`)).not.toBeNull();
    }
    const button = (view.queryByLabelText("Send message") ??
      view.queryByLabelText("Queue message")) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
  });
}

/** Every attachment chip on the composer's strip, by the name on its Remove button. */
function chips({ container }: RenderResult) {
  return Array.from(container.querySelectorAll("[aria-label^='Remove ']"))
    .map((element) => element.getAttribute("aria-label") ?? "")
    .filter((label) => !label.startsWith("Remove queued message"))
    .map((label) => label.slice("Remove ".length));
}

/** What the last user turn on the agent is carrying, as the wire sees it. */
function lastUserContent() {
  const messages = currentAgent().messages;
  const last = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  return last?.content;
}

/**
 * FINDING 1. A drained turn whose send fails must not delete rows the transcript is still showing.
 *
 * The reviewer's reproduction, step for step: park a file mid-turn, let the queue drain when the
 * turn ends, and fail the drained request. `deliver` has already added the user message — with the
 * attachment's URL in it — to `agent.messages` by the time the run is attempted, and nothing
 * removes it when the run rejects. So a release here deletes the row behind a message that is on
 * screen and stays on screen: a broken attachment in the transcript, which is data loss and not a
 * rough edge.
 */
test("a drained turn whose send fails keeps the rows behind the message the transcript still shows", async () => {
  const firstRun = deferred();
  runAnswers = [
    // The turn the file is parked behind: held open until this test ends it.
    () => firstRun.promise,
    // The drained turn: a transient 503 before anything is stamped.
    async () => new NativeResponse("upstream unavailable", { status: 503 }),
  ];

  const view = await mounted();
  const user = userEvent.setup({ document: view.container.ownerDocument });

  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Get started",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(1));

  // A correction typed at a Bot that is already working, with a file under it.
  drop(form(view), [named("plan.txt")]);
  await uploaded(view, ["plan.txt"]);
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Use the attached plan",
  );
  await user.click(view.getByRole("button", { name: "Queue message" }));
  await waitFor(() =>
    expect(
      view.container.querySelector("[aria-label^='Remove queued message']"),
    ).not.toBeNull(),
  );
  expect(deletes).toEqual([]);

  // The turn ends, the queue drains, and the drained send fails.
  firstRun.settle(finished(runs[0] as RunAgentInput));
  await waitFor(() => expect(runs).toHaveLength(2));

  // The drained message reached the wire carrying the row, which is what makes the release below
  // wrong: the same message is now in `agent.messages` and drawn in the transcript.
  await waitFor(() =>
    expect(JSON.stringify(lastUserContent())).toContain(
      attachmentUrl("stored-plan.txt"),
    ),
  );
  expect(view.getAllByText("Use the attached plan").length).toBeGreaterThan(0);

  // THE FINDING. Nothing may delete a row that a message on this screen still points at. The
  // release that used to happen here left the transcript showing an attachment whose bytes were
  // gone, with nothing said and no way back to it.
  await settleReactWork();
  expect(deletes).toEqual([]);

  // And the failed turn is retryable rather than merely undeleted: its words and its file are back
  // in the queue, where the next turn carries them and a Remove is the only thing that drops them.
  //
  // Read off the queued ROW rather than off the button's label, which names the words only: the
  // claim is that the file came back with them, and the file is a tile inside that row.
  const parked = view.container
    .querySelector("[aria-label^='Remove queued message']")
    ?.closest("[data-slot='message']");
  expect(parked).not.toBeNull();
  expect(parked?.textContent).toContain("Use the attached plan");
  expect(parked?.textContent).toContain("plan.txt");
});

/**
 * FINDING 2. Restoring a failed send beside newly staged files must not produce a sendable draft
 * over the per-message cap.
 *
 * `sending` hides the outgoing files from `staged`, so the cap screening counts zero while a send
 * is out and a second full batch is accepted behind it. When the response then fails, clearing
 * `sending` puts both batches on one strip — and `canSendDraft` asks about upload status and
 * emptiness, not about the cap, so that doubled draft stayed sendable and the retry shipped twice
 * the server's per-message budget.
 */
test("a failed send restored beside a second batch cannot be retried over the per-message cap", async () => {
  const firstRun = deferred();
  runAnswers = [() => firstRun.promise];

  const view = await mounted();
  const first = Array.from(
    { length: MAX_ATTACHMENTS_PER_MESSAGE },
    (_, index) => named(`first-${index}.txt`),
  );
  const second = Array.from(
    { length: MAX_ATTACHMENTS_PER_MESSAGE },
    (_, index) => named(`second-${index}.txt`),
  );

  drop(form(view), first);
  await uploaded(
    view,
    first.map((file) => file.name),
  );
  fireEvent.submit(form(view));
  await waitFor(() => expect(runs).toHaveLength(1));
  // The send took them off the strip, which is what frees the client-side count for the batch
  // below — the server has stamped them by now, so it will not refuse these either.
  expect(chips(view)).toEqual([]);

  drop(form(view), second);
  await uploaded(
    view,
    second.map((file) => file.name),
  );
  expect(uploads).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE * 2);

  // The response fails, so the first batch comes back beside the second.
  firstRun.settle(new NativeResponse("upstream unavailable", { status: 503 }));
  await waitFor(() =>
    expect(chips(view)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE * 2),
  );

  // THE FINDING. Sixteen attachments is not a message this deployment accepts, and the button that
  // sends it must say so rather than letting the retry discover it as a rejected request.
  const send = view.getByLabelText("Send message") as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  expect(
    view.getByText(new RegExp(`at most ${MAX_ATTACHMENTS_PER_MESSAGE}`, "i")),
  ).toBeTruthy();

  // Nothing was dropped to get there: every file is still on the strip and still deletable by the
  // person who picked it, and no row was released behind their back.
  expect(deletes).toEqual([]);
  expect(runs).toHaveLength(1);

  // AND IT IS A GATE, NOT A DEAD END. Taking the second batch off by hand — the gesture that HAS
  // always justified releasing a row — puts the draft back inside the cap and Send comes back on.
  for (const file of second) {
    fireEvent.click(view.getByLabelText(`Remove ${file.name}`));
  }
  await waitFor(() => {
    expect(chips(view)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(
      (view.getByLabelText("Send message") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  await waitFor(() =>
    expect(deletes).toEqual(
      second.map((file) => attachmentUrl(`stored-${file.name}`)),
    ),
  );
});

/**
 * THE OTHER HALF OF "RETRYABLE", THROUGH THE SAME REAL PATH. A restored queue entry that nothing
 * ever carries is just an undeleted row with a Remove button on it.
 *
 * The retry is the next turn, and it has to be a turn somebody asked for: a queue that re-sent
 * itself the instant it came back would spin against a server that is refusing every request. So
 * the restored message waits, and the next thing sent takes it along — ahead of the newer words,
 * because it was typed first and the whole reason this queue exists is that a correction must not
 * be read after the sentence correcting it.
 */
test("the next turn carries a restored message, with its file, ahead of the newer words", async () => {
  const firstRun = deferred();
  runAnswers = [
    () => firstRun.promise,
    async () => new NativeResponse("upstream unavailable", { status: 503 }),
  ];

  const view = await mounted();
  const user = userEvent.setup({ document: view.container.ownerDocument });

  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Get started",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(1));

  drop(form(view), [named("plan.txt")]);
  await uploaded(view, ["plan.txt"]);
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "Use the attached plan",
  );
  await user.click(view.getByRole("button", { name: "Queue message" }));

  // The turn ends, the queue drains, and the drained send fails.
  firstRun.settle(finished(runs[0] as RunAgentInput));
  await waitFor(() => expect(runs).toHaveLength(2));
  await waitFor(() =>
    expect(
      view.container.querySelector("[aria-label^='Remove queued message']"),
    ).not.toBeNull(),
  );

  // Nothing ran on its own while it sat there. The restore is a retry somebody can take, not one
  // this screen keeps attempting.
  await settleReactWork();
  expect(runs).toHaveLength(2);

  // The next thing sent takes it along.
  await user.type(
    view.getByRole("textbox", { name: "Message" }),
    "And the summary too",
  );
  await user.click(view.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runs).toHaveLength(3));

  const sent = runs[2]?.messages.at(-1);
  expect(JSON.stringify(sent?.content)).toContain(
    attachmentUrl("stored-plan.txt"),
  );
  // In the order they were typed: the message that failed, then the one typed after it.
  expect(JSON.stringify(sent?.content)).toContain(
    "Use the attached plan\\nAnd the summary too",
  );

  // Carried, not copied: the queue gave it up to the run, so nothing is left waiting to run again.
  expect(
    view.container.querySelector("[aria-label^='Remove queued message']"),
  ).toBeNull();
  expect(deletes).toEqual([]);
});
