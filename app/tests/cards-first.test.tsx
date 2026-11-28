import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useCardsFirst } from "@/components/computer/use-cards-first";
import { passwordKeys } from "@/lib/passwords/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The Computer, a sheet over a conversation on a phone, gives way to a card there that waits on the
 * person: an approval for a step in this conversation, or a private sign-in its Bot asked for. The
 * take-over card is driven end to end in computer-panel-phone-layout.test.tsx; these two are read
 * from the approvals inbox and the sign-in requests, put in the query cache here as the server
 * answers them.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register();
  // The Bot's wheel is not what these cases are about: nobody has asked to be taken over.
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "Not found" }, { status: 404 }),
    { preconnect: () => undefined },
  );
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const THREAD = "garden-thread";

/** An approval waiting on the person, as the inbox holds it. */
const approval = (id: string, threadId: string) => ({
  id,
  status: "pending",
  createdAt: "2026-11-26T18:00:00Z",
  action: {
    botId: "fernhill-member",
    toolRef: "computer_click",
    effect: "write",
    scope: "browser",
    threadId,
    toolCallId: `call-${id}`,
    args: {},
    policy: { behaviour: "ask", source: "safety", reason: "Asks first." },
  },
});

/** A private sign-in the Bot asked for, as the sign-in requests list it. */
const signIn = (id: string, status: string) => ({
  id,
  botId: "fernhill-member",
  origin: "https://fernhill.example",
  reason: null,
  status,
  method: null,
  outcome: null,
  threadId: THREAD,
  toolCallId: `call-${id}`,
  controlRequestId: null,
  createdAt: "2026-11-26T18:00:00Z",
  expiresAt: "2026-11-26T18:15:00Z",
});

function conversation(covers: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["approvals"], { requests: [], questions: [] });
  client.setQueryData(passwordKeys.pending(), []);
  const closed: number[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    (props: { watching: boolean }) =>
      useCardsFirst({
        botId: "fernhill-member",
        threadId: THREAD,
        covers,
        watching: props.watching,
        close: () => closed.push(1),
      }),
    { wrapper, initialProps: { watching: true } },
  );
  return {
    closed,
    view,
    /** The server's answer changes, and the screen has read it. */
    approvals: (...requests: unknown[]) =>
      settled(() =>
        client.setQueryData(["approvals"], { requests, questions: [] }),
      ),
    signIns: (...requests: unknown[]) =>
      settled(() => client.setQueryData(passwordKeys.pending(), requests)),
  };
}

/** Change the cache, then let its observers and React catch up. */
async function settled(change: () => void) {
  await act(async () => {
    change();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("an approval that starts waiting closes the Computer over the conversation, once", async () => {
  const here = conversation(true);

  await here.approvals(approval("delete", THREAD));

  expect(here.closed).toHaveLength(1);
  expect(here.view.result.current.cardWaiting).toBe(true);
  // Opened again by the person, it stays: the same card is not a new one.
  here.view.rerender({ watching: true });
  await here.approvals(approval("delete", THREAD));
  expect(here.closed).toHaveLength(1);
});

test("an approval in another conversation, or beside a wide one, leaves the Computer open", async () => {
  const phone = conversation(true);
  await phone.approvals(approval("elsewhere", "another-thread"));
  expect(phone.closed).toHaveLength(0);
  expect(phone.view.result.current.cardWaiting).toBe(false);

  const wide = conversation(false);
  await wide.approvals(approval("delete", THREAD));
  expect(wide.closed).toHaveLength(0);
});

test("a private sign-in that starts waiting closes the Computer over the conversation; one that ended does not", async () => {
  const ended = conversation(true);
  await ended.signIns(signIn("done", "signed_in"));
  expect(ended.closed).toHaveLength(0);

  const here = conversation(true);
  await here.signIns(signIn("members", "pending"));
  expect(here.closed).toHaveLength(1);
  expect(here.view.result.current.cardWaiting).toBe(true);
});
