import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import {
  botOperationPath,
  noContent,
  problemResponse,
  type SentRequest,
  sentRequest,
} from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * When a Bot declines something it was asked, it says so with `report_refusal`, and the app puts it
 * on the audit trail at the Bot's address in the API. The report is bookkeeping: whatever the server
 * answers, or if it can't be reached, the Bot is told to answer the person anyway.
 *
 * The tool is the one the app registers, captured by spying on the SDK's namespace as
 * `navigation-without-page.test.tsx` does, and called as the SDK calls it during a Bot's turn.
 */

type Registered = Parameters<typeof ReactCoreV2.useFrontendTool>[0];
const registered: Registered[] = [];
const useCopilotKitSpy = spyOn(ReactCoreV2, "useCopilotKit").mockImplementation(
  () => ({ copilotkit: { stopAgent: () => undefined } }) as never,
);
const useFrontendToolSpy = spyOn(
  ReactCoreV2,
  "useFrontendTool",
).mockImplementation((tool) => {
  if (!registered.some((entry) => entry.name === tool.name))
    registered.push(tool as unknown as Registered);
});

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  useCopilotKitSpy.mockRestore();
  useFrontendToolSpy.mockRestore();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** What the Bot's turn hands the tool: the Bot whose run it is, and the turn's abort signal. */
type Context = { agent: { agentId: string }; signal: AbortSignal };

function reportRefusal(): (
  input: { reason: string; request?: string },
  context: Context,
) => Promise<unknown> {
  if (!registered.some((entry) => entry.name === "report_refusal")) {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ComputerTools />
      </QueryClientProvider>,
    );
    cleanup();
  }
  const tool = registered.find((entry) => entry.name === "report_refusal");
  if (!tool?.handler) throw new Error("report_refusal has no handler.");
  return tool.handler as never;
}

function serving(answer: () => Response) {
  const sent: (SentRequest & { signal: AbortSignal | null | undefined })[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ ...sentRequest(input, init), signal: init?.signal });
    return answer();
  }) as unknown as typeof fetch;
  return sent;
}

test("a decline is reported for the Bot whose turn it is, in its own words", async () => {
  const sent = serving(noContent);
  const turn = new AbortController();
  const said = await reportRefusal()(
    {
      reason: "Wiring money to a stranger looked like fraud.",
      request: "Send $900 to this account",
    },
    { agent: { agentId: "expenses" }, signal: turn.signal },
  );
  expect(said).toBe("Recorded. Now tell the person what you decided and why.");
  expect(sent).toEqual([
    {
      method: "POST",
      path: botOperationPath("expenses", "report-decline"),
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: {
        reason: "Wiring money to a stranger looked like fraud.",
        request: "Send $900 to this account",
      },
      // Abandoned with the turn.
      signal: turn.signal,
    },
  ]);
});

test("a report the server refused, or that never arrived, still lets the Bot answer", async () => {
  const handler = reportRefusal();
  const context = {
    agent: { agentId: "expenses" },
    signal: new AbortController().signal,
  };
  serving(() => problemResponse(403, "That Bot isn't yours to report on."));
  expect(await handler({ reason: "Not for me." }, context)).toBe(
    "That could not be recorded. Tell the person what you decided anyway.",
  );

  const sent = serving(() => {
    throw new TypeError("Failed to fetch");
  });
  expect(await handler({ reason: "Not for me." }, context)).toBe(
    "That could not be recorded. Tell the person what you decided anyway.",
  );
  // Only what the Bot said: no request it didn't give.
  expect(sent[0]?.body).toEqual({ reason: "Not for me." });
});
