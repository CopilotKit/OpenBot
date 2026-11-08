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

function serving(open: (typeof signInRequest)[]) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/sign-in-requests" && method === "POST")
        return Response.json(signInRequest, { status: 201 });
      if (path === "/api/sign-in-requests")
        return Response.json({ requests: open });
      if (path === `/api/sign-in-requests/${signInRequest.id}`)
        return Response.json(signInRequest);
      return Response.json({ error: "Not found" }, { status: 404 });
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
      if (path === "/api/sign-in-requests")
        return Response.json({ requests: [offered] });
      if (path === `/api/sign-in-requests/${offered.id}`)
        return Response.json(offered);
      return Response.json({ error: "Not found" }, { status: 404 });
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
