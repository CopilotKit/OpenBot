import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { SignInTool } from "@/lib/copilot/sign-in-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * The open chat's sign-in card, drawn by the renderer the SDK actually keeps.
 *
 * The SDK registers a frontend tool's renderer once and does not re-register it when the function
 * changes, so anything the renderer reads from the registering component's render is frozen at first
 * render. The card used to take its request id from state the handler set, which the kept renderer
 * never saw: the card said "Waiting for you to sign in" with no way to open the form. This uses the
 * real provider and the real hook, so an SDK that changes how it keeps renderers is caught here too.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  focusManager.setFocused(undefined);
});

const TOOL_CALL_ID = "call-sign-in";
const SITE = "https://shop.example";
const signInRequest = {
  id: "request-1",
  botId: "default",
  origin: SITE,
  reason: null,
  status: "pending",
  method: null,
  outcome: null,
  threadId: null,
  toolCallId: TOOL_CALL_ID,
  controlRequestId: null,
  createdAt: "2026-10-12T10:00:00Z",
  expiresAt: "2026-10-12T10:15:00Z",
  resolvedAt: null,
  passwordManager: false,
  savedLogins: [],
};

/** Where the API answers a person's own sign-in requests. */
const SIGN_IN_REQUESTS =
  "/api/v2/organizations/default/people/me/sign-in-requests";

function serving(open: (typeof signInRequest)[]) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const method = init?.method ?? "GET";
      if (path === SIGN_IN_REQUESTS && method === "POST")
        return Response.json({ signInRequest }, { status: 201 });
      if (path === SIGN_IN_REQUESTS)
        return Response.json({ signInRequests: open, nextCursor: null });
      if (path === `${SIGN_IN_REQUESTS}/${signInRequest.id}`)
        return Response.json({ signInRequest });
      return Response.json({ detail: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

type Renderer = ComponentType<Record<string, unknown>>;
type Handler = (args: unknown, context: unknown) => Promise<unknown>;

/**
 * Read from the SDK when asked, not when Capture renders: the provider does not re-render its
 * consumers when a tool is added, so a read at render time sees the registry before the tool did.
 */
class Registry {
  copilotkit?: ReturnType<typeof useCopilotKit>["copilotkit"];
  get renderer() {
    return this.copilotkit?.renderToolCalls.find(
      (candidate) => candidate.name === "computer_request_sign_in",
    )?.render as Renderer | undefined;
  }
  get handler() {
    return this.copilotkit?.getTool({ toolName: "computer_request_sign_in" })
      ?.handler as Handler | undefined;
  }
}

function Capture({ kept }: { kept: Registry }) {
  kept.copilotkit = useCopilotKit().copilotkit;
  return null;
}

function Providers({
  queries,
  children,
}: {
  queries: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queries}>
      <CopilotKitProvider>{children}</CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("the waiting card offers the private sign-in once the request exists", async () => {
  serving([]);
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kept = new Registry();
  const tree = render(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
    </Providers>,
  );
  await waitFor(() => expect(kept.handler).toBeDefined());

  // The chat draws the call as soon as it streams in, before the handler has opened the request.
  const Kept = kept.renderer as Renderer;
  const drawn = (
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
      <Kept
        name="computer_request_sign_in"
        args={{ site: SITE }}
        status="executing"
        toolCallId={TOOL_CALL_ID}
      />
    </Providers>
  );
  serving([]);
  tree.rerender(drawn);
  await tree.findByText("Waiting for you to sign in");
  // Long enough for a card that looks the request up to have looked once and found nothing.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // In a background tab nothing polls, so the request has to reach the card without a timer.
  focusManager.setFocused(false);
  serving([signInRequest]);

  // The model calls the tool: the handler opens the request on the server and waits on it.
  const stop = new AbortController();
  const answered = kept.handler?.(
    { site: SITE },
    { signal: stop.signal, toolCall: { id: TOOL_CALL_ID } },
  );

  const open = await tree.findByRole(
    "button",
    { name: /Open private sign-in/ },
    { timeout: 4000 },
  );
  focusManager.setFocused(undefined);
  fireEvent.click(open);
  await tree.findByText(`Sign in to ${SITE}`);
  await tree.findByText(/Goes to your Bot's browser/);

  stop.abort();
  await answered;
});

/**
 * A sign-in the server holds: the run that asked stopped on the server's own wait for it, and the
 * server opened the request and carries the conversation on once the person signs in, page open or
 * not. The call has no answer yet, so the SDK hands it to this app's handler as well. Acted on, it
 * opened a second request, a second form, and the card read "Sign-in did not complete" over the
 * form the person still had to fill in.
 */
test("a sign-in the server holds opens no second request, and its card offers the server's form", async () => {
  const posted: string[] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (init?.method === "POST") posted.push(path);
      if (path === SIGN_IN_REQUESTS && init?.method === "POST")
        return Response.json({ signInRequest }, { status: 201 });
      if (path === SIGN_IN_REQUESTS)
        return Response.json({
          signInRequests: [signInRequest],
          nextCursor: null,
        });
      if (path === `${SIGN_IN_REQUESTS}/${signInRequest.id}`)
        return Response.json({ signInRequest });
      return Response.json({ detail: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kept = new Registry();
  const tree = render(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
    </Providers>,
  );
  await waitFor(() => expect(kept.handler).toBeDefined());

  // The run ended on the interrupt the server sends for it.
  const agent = {
    threadId: "thread",
    messages: [],
    pendingInterrupts: [
      {
        id: TOOL_CALL_ID,
        toolCallId: TOOL_CALL_ID,
        reason: "human_input",
        message: `Waiting for the person to sign in to ${SITE} in a private form.`,
        metadata: {
          openbotWaiting: {
            kind: "computer_sign_in",
            requestId: signInRequest.id,
            site: SITE,
          },
        },
      },
    ],
  };
  const answer = await kept.handler?.(
    { site: SITE },
    { agent, toolCall: { id: TOOL_CALL_ID } },
  );
  expect(answer).toEqual({ waiting: true });
  expect(posted).toEqual([]);

  // The card, drawn with that stand-in as the call's answer, waits on the server's request.
  const Kept = kept.renderer as Renderer;
  tree.rerender(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
      <Kept
        name="computer_request_sign_in"
        args={{ site: SITE }}
        status="complete"
        result={JSON.stringify(answer)}
        toolCallId={TOOL_CALL_ID}
      />
    </Providers>,
  );
  await tree.findByText("Waiting for you to sign in");
  expect(tree.queryByText("Sign-in did not complete")).toBeNull();
  fireEvent.click(
    await tree.findByRole(
      "button",
      { name: /Open private sign-in/ },
      { timeout: 4000 },
    ),
  );
  await tree.findByText(`Sign in to ${SITE}`);
});

/**
 * The dialog's own spacing, not a page's. The form's sections are page sections, and a page puts
 * 48px above each one to keep unrelated decisions apart. In the dialog that left a large empty gap
 * above "Use a saved login" and another above "Enter your login".
 */
test("the private sign-in dialog spaces its sections as a dialog does", async () => {
  const offered = {
    ...signInRequest,
    passwordManager: true,
    savedLogins: [{ id: "login-1", username: "tomsmith" }],
  };
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === SIGN_IN_REQUESTS)
        return Response.json({ signInRequests: [offered], nextCursor: null });
      if (path === `${SIGN_IN_REQUESTS}/${offered.id}`)
        return Response.json({ signInRequest: offered });
      return Response.json({ detail: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kept = new Registry();
  const tree = render(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
    </Providers>,
  );
  await waitFor(() => expect(kept.renderer).toBeDefined());
  const Kept = kept.renderer as Renderer;
  tree.rerender(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
      <Kept
        name="computer_request_sign_in"
        args={{ site: SITE }}
        status="executing"
        toolCallId={TOOL_CALL_ID}
      />
    </Providers>,
  );
  fireEvent.click(
    await tree.findByRole(
      "button",
      { name: /Open private sign-in/ },
      { timeout: 4000 },
    ),
  );

  const body = (await tree.findByText("Use a saved login")).closest(
    "[data-slot=dialog-body]",
  ) as HTMLElement;
  expect(body).not.toBeNull();
  const sections = [...body.querySelectorAll(":scope > section")];
  expect(
    sections.map((section) => section.querySelector("h2")?.textContent),
  ).toEqual(["Use a saved login", "Enter your login"]);
  for (const section of sections) {
    // Spaced by the dialog body's own gap, with no page margin of its own above it.
    expect(section.className.split(/\s+/)).toContain("mt-0");
    expect(section.className.split(/\s+/)).not.toContain("mt-12");
  }
  // And the fields sit a step below the words that introduce them, not hard against them.
  const form = body.querySelector("form") as HTMLFormElement;
  expect(form.className.split(/\s+/)).toContain("mt-4");
});
