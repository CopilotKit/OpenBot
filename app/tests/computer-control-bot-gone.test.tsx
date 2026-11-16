import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import { useComputerControl } from "@/lib/computers/use-control";
import { DEPLOYMENT_PATH, deploymentResponse } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot that is not the person's any more is not asked about every second.
 *
 * Seen on a real server: a person had a conversation open with a Bot shared with their team, and an
 * admin took them out of the team. From then on the API answered the read of who has control of the
 * Bot's computer with 404, and the open conversation asked again every second: 55 times in one
 * capture. The 404 is the answer. Nothing a second later changes it.
 *
 * Drawn for real: the conversation's check for a paused browser task and the control state every
 * view of a Bot's computer shares, through the generated client, against a server stand-in at the
 * API's address that answers as the server does and counts what it was asked.
 */

const CONTROL =
  /^\/api\/v2\/organizations\/default\/computers\/([^/]+)\/control$/;
const originalFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const HELD = {
  holder: "human",
  since: new Date(0).toISOString(),
  requested: false,
};

/** The API's `ComputerBotNotFound`, as api/openapi/computers.yaml gives it. */
function botNotFound() {
  return Response.json(
    {
      type: "https://open.bot/errors/bot-not-found",
      title: "Bot not found.",
      status: 404,
      detail: "Couldn't find that Bot.",
      code: "BOT_NOT_FOUND",
      category: "not_found",
      retryable: false,
    },
    { status: 404, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * A server that answers the control read with each of `answers` in turn, the last one from then on.
 * Returns how many times control was read.
 */
function answering(answers: Array<"held" | "not-found" | "breaks">) {
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://openbot.test").pathname;
    if (path === DEPLOYMENT_PATH)
      return deploymentResponse({ botComputers: true });
    if (!CONTROL.test(path)) return new Response(null, { status: 401 });
    const answer = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    if (answer === "held") return Response.json(HELD);
    if (answer === "not-found") return botNotFound();
    return new Response(null, { status: 502 });
  }) as typeof fetch;
  return () => reads;
}

/** Three of the poll's seconds. */
async function threeSeconds() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3300));
  });
}

const quiet = { messages: [], isRunning: false, setMessages: () => {} };
function notice(botId: string) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HandoffResumeNotice
        agent={quiet}
        botId={botId}
        ready
        run={async () => {}}
      />
    </QueryClientProvider>
  );
}

test("an open conversation stops reading control once the Bot is not the person's any more", async () => {
  const reads = answering(["held", "not-found"]);
  render(notice("taken-away-bot"));

  await threeSeconds();
  // The read that answered, and the one that said the Bot is gone. None after it.
  expect(reads()).toBe(2);
}, 10_000);

test("an open conversation keeps reading control while the server is only failing", async () => {
  // A server that broke is not a Bot that is gone: the next read may well answer.
  const reads = answering(["breaks"]);
  render(notice("flaky-bot"));

  await threeSeconds();
  expect(reads()).toBeGreaterThanOrEqual(3);
}, 10_000);

/** What a view of the Bot's computer reads of the wheel. */
function Probe({
  computerId,
  seen,
}: {
  computerId: string;
  seen: Array<string | null>;
}) {
  const { control, problem } = useComputerControl(computerId);
  seen.push(problem ?? control?.holder ?? null);
  return null;
}

test("a view of the Bot's computer stops reading control once the Bot is not the person's any more, and says nothing is reconnecting", async () => {
  const reads = answering(["held", "not-found"]);
  const seen: Array<string | null> = [];
  render(<Probe computerId="taken-away-computer" seen={seen} />);
  await waitFor(() => expect(seen).toContain("human"));

  await threeSeconds();
  expect(reads()).toBe(2);
  // The wheel is nobody's here now, and no sentence claims a connection is coming back.
  expect(seen.at(-1)).toBeNull();
  expect(seen.filter((said) => said?.startsWith("Reconnecting"))).toEqual([]);
}, 10_000);

test("coming back to the tab asks once more, in case the Bot is theirs again", async () => {
  const reads = answering(["not-found", "not-found", "held"]);
  const seen: Array<string | null> = [];
  render(<Probe computerId="shared-again-computer" seen={seen} />);
  await threeSeconds();
  expect(reads()).toBe(1);

  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(reads()).toBe(2);
  // Shared with them again by the time they look a second time: the wheel is read as before.
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 1500));
  });
  expect(seen.at(-1)).toBe("human");
  expect(reads()).toBeGreaterThanOrEqual(4);
}, 10_000);
