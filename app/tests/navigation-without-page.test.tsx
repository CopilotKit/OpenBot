import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { ComputerView } from "@/components/computer/computer-view";
import { failedComputerCall } from "@/lib/computers/call";
import { WAITING_FOR_PERSON } from "@/lib/copilot/approval-context";
import { ComputerTools } from "@/lib/copilot/computer-tools";

/**
 * A navigation that opened no page draws no screen.
 *
 * In a Bot conversation every `computer_navigate` drew the Bot's screen as a card. A navigation that
 * was refused by a boundary, or failed, ended with no page, and the card stayed on anyway: a grey
 * box the width of the conversation, between the Bot's sentence and its answer, saying only "This
 * turn did not open a page." It now draws one line, as every other step that did not happen does,
 * and a navigation that is loading or opened a page keeps its card.
 *
 * Drawn through the renderer the app registers for the tool, which is what the conversation calls,
 * with each result in the shape the tool's handler hands the SDK (`failedComputerCall` is the
 * handler's own refusal path). The registrations are captured by spying on the SDK's namespace, as
 * `approval-tools.test.tsx` does, and restored afterwards.
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

const BOT = "general-assistant";
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  // The server, as far as a conversation's screen asks it anything.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const path = String(input);
    if (path.endsWith("/api/approvals")) return Response.json({ requests: [] });
    if (path.includes("/page-frame/")) return Response.json({ frame: null });
    if (path.endsWith("/control"))
      return Response.json({
        holder: "bot",
        since: new Date(0).toISOString(),
        requested: false,
      });
    if (path.endsWith("/status"))
      return Response.json({ botId: BOT, state: "ready" });
    if (path.endsWith("/screenshot"))
      return Response.json({
        base64: "AAAA",
        width: 320,
        height: 200,
        capturedAt: new Date(0).toISOString(),
        url: "https://example.com/",
      });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = originalFetch;
  useCopilotKitSpy.mockRestore();
  useFrontendToolSpy.mockRestore();
  GlobalRegistrator.unregister();
});

function withQueries(ui: ReactElement) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queries}>{ui}</QueryClientProvider>,
  );
}

/** The renderer the app registered for `computer_navigate`, as the conversation calls it. */
function navigationRenderer(): (
  props: Record<string, unknown>,
) => ReactElement {
  if (!registered.some((entry) => entry.name === "computer_navigate")) {
    withQueries(<ComputerTools />);
    cleanup();
  }
  const tool = registered.find((entry) => entry.name === "computer_navigate");
  if (!tool?.render) throw new Error("computer_navigate draws nothing.");
  // The approval wrapper's element, with the tool's own renderer inside it.
  return tool.render as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement;
}

/** One `computer_navigate` call in the conversation, as the SDK hands it to the renderer. */
function drawNavigation(
  url: string,
  result: unknown,
  status: "executing" | "complete" = "complete",
) {
  const draw = navigationRenderer();
  return withQueries(
    draw({
      name: "computer_navigate",
      toolCallId: `navigate-${url}`,
      args: { url },
      status,
      result: result === undefined ? undefined : JSON.stringify(result),
    }),
  );
}

const SCREEN = { name: "Open the Bot's screen full size" };

test("a navigation a boundary refused draws one line and no screen", async () => {
  const view = drawNavigation(
    "https://x.com",
    failedComputerCall(403, {
      error:
        'This deployment\'s policy does not allow that: a navigate action on x.com is blocked by the rule `page.host == "x.com"`.',
    }),
  );

  expect(await view.findByText("Blocked: Open")).toBeTruthy();
  expect(view.getByText("x.com")).toBeTruthy();
  expect(view.queryByRole("button", SCREEN)).toBeNull();
  expect(view.container.querySelector("figure")).toBeNull();
  expect(view.queryByText(/did not open a page/)).toBeNull();
  // The rule is the model's sentence. The Bot's answer says why, in words.
  expect(view.queryByText(/page\.host/)).toBeNull();
});

test("a navigation that failed draws one line and no screen", async () => {
  const view = drawNavigation(
    "https://openbot-check.invalid",
    failedComputerCall(502, {
      error: "net::ERR_NAME_NOT_RESOLVED at https://openbot-check.invalid/",
    }),
  );

  expect(await view.findByText("Opened, didn't work")).toBeTruthy();
  expect(view.getByText("openbot-check.invalid")).toBeTruthy();
  expect(view.queryByRole("button", SCREEN)).toBeNull();
  expect(view.container.querySelector("figure")).toBeNull();
});

test("a navigation still held for the person's approval draws nothing of its own", () => {
  const view = drawNavigation("https://example.com", WAITING_FOR_PERSON);

  expect(view.queryByRole("button", SCREEN)).toBeNull();
  expect(view.container.querySelector("figure")).toBeNull();
  expect(view.queryByText(/Opened|Blocked/)).toBeNull();
});

test("a navigation that opened a page keeps its card, naming the page", async () => {
  const view = drawNavigation("https://example.com", {
    ok: true,
    url: "https://example.com/",
    title: "Example Domain",
    text: "Example Domain",
  });

  expect(view.getByRole("button", SCREEN)).toBeTruthy();
  // The card's address bar, as the browser's own says where it is.
  expect(view.container.querySelector("figcaption")?.textContent).toContain(
    "example.com",
  );
  expect(await view.findByText("Example Domain")).toBeTruthy();
  expect(view.queryByText(/didn't work|Blocked/)).toBeNull();
});

test("a navigation still loading keeps its card, so the conversation does not move under it", () => {
  const view = drawNavigation("https://example.com", undefined, "executing");

  expect(view.getByRole("button", SCREEN)).toBeTruthy();
  expect(view.queryByText(/didn't work|Blocked/)).toBeNull();
});

test("the screen itself draws nothing for a finished turn with no page, and a card for one with a page", async () => {
  const nothing = withQueries(
    <ComputerView
      active={false}
      computerId={BOT}
      finished
      toolCallId="call-refused"
    />,
  );
  expect(nothing.container.innerHTML).toBe("");
  cleanup();

  const opened = withQueries(
    <ComputerView
      active={false}
      computerId={BOT}
      finished
      page={{ url: "https://example.com/", title: "Example Domain" }}
      toolCallId="call-opened"
    />,
  );
  expect(opened.getByRole("button", SCREEN)).toBeTruthy();
  await waitFor(() => expect(opened.getByText("Example Domain")).toBeTruthy());
});
