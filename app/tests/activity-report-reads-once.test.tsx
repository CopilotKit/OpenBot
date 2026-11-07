import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { NOT_SHOWN, NOT_SHOWN_TAIL } from "@openbot/shared/component-markers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { GALLERY } from "@/components/gallery/activity";
import { agentKeys } from "@/lib/agents/queries";
import {
  ArgumentsArrivingContext,
  TurnInFlightContext,
} from "@/components/gallery/streaming";
import { makeGalleryRender } from "@/lib/copilot/gallery-tools";
import { createGrantStore } from "@/lib/copilot/grant-store";
import { settleReactWork } from "./settle-react-work";

/*
 * Seen in the personal edition: one request for an Activity report wrote three refused rows to the
 * trail. The card asked the server for its data while its arguments were still streaming in (no
 * `days` yet), the call's handler asked for its decision, and the card asked again once `days`
 * arrived. Every ask that is refused is a row. The card now reads once the call is decided: never
 * for a refused call, which leaves the handler's one row, and once for an allowed one. Its figures
 * name each Bot as people know it, never by the id the trail counts it under.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const spec = GALLERY.find(({ name }) => name === "showActivityReport");
if (!spec) throw new Error("the Activity report is not in the gallery");

/** Every read the card asks of `POST /api/components/showActivityReport/call`. */
let reads: unknown[] = [];
const originalFetch = global.fetch;
beforeAll(() => {
  // What the server answers an allowed read of `botActivity` (`server/src/components/routes.ts`).
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/api/components/showActivityReport/call")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        reads.push(body);
        return Response.json({
          allowed: true,
          data:
            body.function === "recentRefusals"
              ? {
                  rows: [
                    {
                      at: "2026-11-07T19:00:00Z",
                      bot: "personal-assistant",
                      what: "computer.action_refused",
                      reason: "Local computer access is off for you.",
                    },
                  ],
                }
              : { days: 7, rows: [{ bot: "personal-assistant", actions: 42 }] },
        });
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});
afterEach(() => {
  reads = [];
});

/** One call as the conversation draws it: the newest row of a turn that is still running. */
function drawCall(report = "activity") {
  const store = createGrantStore();
  store.set({
    grants: {
      status: "known",
      held: new Map([["showActivityReport", spec?.description ?? ""]]),
    },
  });
  const Render = makeGalleryRender(spec as NonNullable<typeof spec>, store);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "personal-assistant", name: "Personal Assistant" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const inTurn = (props: Parameters<typeof Render>[0], running = true) => (
    <QueryClientProvider client={queryClient}>
      <TurnInFlightContext.Provider value={running}>
        <ArgumentsArrivingContext.Provider value={running}>
          <Render toolCallId="call-1" {...props} />
        </ArgumentsArrivingContext.Provider>
      </TurnInFlightContext.Provider>
    </QueryClientProvider>
  );
  const view = render(inTurn({ args: { report }, status: "inProgress" }));
  // The rest of the arguments, then the handler deciding.
  view.rerender(inTurn({ args: { report, days: 7 }, status: "inProgress" }));
  view.rerender(inTurn({ args: { report, days: 7 }, status: "executing" }));
  return { view, store, inTurn };
}

test("a refused call reads nothing, so its one refusal is the handler's", async () => {
  const { view, store, inTurn } = drawCall();
  const reason = "It can't read the data it needs.";
  // What the handler does with a refused decision before it answers the call.
  act(() => store.set({ refusals: new Map([["call-1", reason]]) }));
  view.rerender(
    inTurn(
      {
        args: { report: "activity", days: 7 },
        status: "complete",
        result: `${NOT_SHOWN}Activity report. ${reason}${NOT_SHOWN_TAIL}`,
      },
      false,
    ),
  );
  await settleReactWork();
  expect(view.getByText(reason)).toBeTruthy();
  expect(reads).toEqual([]);
});

test("an allowed call reads once, with its final arguments, and draws the figures", async () => {
  const { view, inTurn } = drawCall();
  expect(view.getByText("Reading…")).toBeTruthy();
  view.rerender(
    inTurn(
      {
        args: { report: "activity", days: 7 },
        status: "complete",
        result: spec.confirmation ?? "",
      },
      false,
    ),
  );
  await waitFor(() => expect(view.getByText("42")).toBeTruthy());
  expect(view.getByText("Personal Assistant")).toBeTruthy();
  expect(view.container.textContent).not.toContain("personal-assistant");
  expect(reads).toEqual([
    { agentId: "default", args: { days: 7 }, function: "botActivity" },
  ]);
});

test("the refusals report says what was refused in words, and names the Bot", async () => {
  const { view, inTurn } = drawCall("refusals");
  view.rerender(
    inTurn(
      {
        args: { report: "refusals", days: 7 },
        status: "complete",
        result: spec.confirmation ?? "",
      },
      false,
    ),
  );
  await waitFor(() => expect(view.getByText("Use the computer")).toBeTruthy());
  expect(view.getByText("Personal Assistant")).toBeTruthy();
  expect(view.container.textContent).not.toContain("computer.action_refused");
  expect(reads).toHaveLength(1);
});
