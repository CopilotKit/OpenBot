/**
 * Settings → General → AI model inside OpenBot Desktop: a plan or a sign-in changes the connection
 * with OpenBot running.
 *
 * Before, Change there only asked Desktop to stop OpenBot and reopen its setup window
 * (`change_ai_connection`). Now the page signs in through Desktop, has Desktop start the one engine a
 * plan needs, switches the server, and has Desktop settle to it; a refused switch settles Desktop
 * back to the connection still in use.
 *
 * The IPC Tauri injects stands in for Desktop's page commands as the contract names them
 * (desktop_page.rs: `ai_providers`, `begin_plan_sign_in`, `finish_plan_sign_in`,
 * `prepare_ai_connection`, `settle_ai_connection`), and `fetch` answers the API as
 * api/openapi.yaml says, every body checked against the generated schemas. The General page, its
 * queries and its mutation are the real ones.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { finishesInDesktop } from "@/lib/ai-connection/desktop";
import type { AiConnection } from "@/lib/api/generated/model";
import {
  GetAiConnectionResponse,
  ReplaceAiConnectionBody,
} from "@/lib/api/generated/models/models.zod";
import { modelKeys } from "@/lib/models/queries";
import { queryClient } from "@/query-client";
import { Route as GeneralRoute } from "@/routes/_authed/settings/index";
import { settleReactWork } from "./settle-react-work";

const AI_CONNECTION = "/api/v2/organizations/default/ai-connection";

const OPENAI_KEY: AiConnection = {
  provider: "openai",
  login: "api-key",
  model: null,
  endpointHost: null,
  keySet: true,
  ready: true,
  source: "stored",
  editable: true,
  saved: [{ provider: "openai", login: "api-key", endpointHost: null }],
  changedAt: "2026-11-14T09:00:00.000Z",
};

const ENGINE_NOT_READY = {
  type: "https://open.bot/errors/ai-connection-refused",
  title: "OpenBot couldn't use that connection.",
  status: 422,
  detail: "Claude hasn't started yet. Try again in a moment.",
  code: "AI_CONNECTION_ENGINE_NOT_READY",
  category: "validation",
  retryable: true,
  requestId: "req_test",
  traceId: "trace_test",
};

/**
 * Claude's authorize address as Desktop answers it: the loopback redirect, which finishes on its
 * own, or Claude's code page, from a Desktop older than that (it ignores `redirect`).
 */
function claudeAuthorize(redirectUri: string) {
  const url = new URL("https://claude.com/cai/oauth/authorize");
  for (const [name, value] of [
    ["code", "true"],
    ["client_id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"],
    ["response_type", "code"],
    ["redirect_uri", redirectUri],
    ["scope", "user:inference"],
    ["code_challenge", "challenge"],
    ["code_challenge_method", "S256"],
    ["state", "state"],
  ])
    url.searchParams.set(name, value);
  return url.toString();
}
const LOOPBACK = claudeAuthorize("http://localhost:53682/callback");
const MANUAL = claudeAuthorize(
  "https://platform.claude.com/oauth/code/callback",
);

let connection: AiConnection;
let refuse: boolean;
/** What this Desktop answers `begin_plan_sign_in` for Claude with. */
let claudeUrl: string;
/** Everything Desktop and the server were asked, in order. */
let calls: { what: string; args?: unknown }[];

/** What was asked of the AI connection: the rest of General reads its own things. */
const AI_CALLS = new Set([
  "ai_providers",
  "begin_plan_sign_in",
  "finish_plan_sign_in",
  "cancel_plan_sign_in",
  "prepare_ai_connection",
  "replaceAiConnection",
  "settle_ai_connection",
  "change_ai_connection",
]);
const aiCalls = () => calls.filter((call) => AI_CALLS.has(call.what));

async function shellInvoke(command: string, args?: Record<string, unknown>) {
  const what = command.replace("plugin:openbot-desktop|", "");
  calls.push({ what, args });
  switch (what) {
    case "ai_providers":
      return [];
    case "begin_plan_sign_in":
      return { url: claudeUrl };
    case "finish_plan_sign_in":
    case "cancel_plan_sign_in":
    case "settle_ai_connection":
      return null;
    case "prepare_ai_connection":
      return { ready: true };
  }
  throw `command ${command} not found`;
}

const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  calls = [];
  refuse = false;
  connection = OPENAI_KEY;
  claudeUrl = LOOPBACK;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
  // The sign-in page opens in the browser; nothing to open here.
  window.open = () => null;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:3010/");
      if (url.pathname !== AI_CONNECTION)
        return new Response(null, { status: 404 });
      if ((init?.method ?? "GET") === "GET")
        return Response.json(GetAiConnectionResponse.parse(connection));
      const body = JSON.parse(String(init?.body));
      calls.push({ what: "replaceAiConnection", args: body });
      const input_ = ReplaceAiConnectionBody.parse(body);
      if (refuse)
        return new Response(JSON.stringify(ENGINE_NOT_READY), {
          status: 422,
          headers: { "content-type": "application/problem+json" },
        });
      connection = {
        ...OPENAI_KEY,
        provider: input_.provider,
        login: input_.login,
        changedAt: "2026-11-17T23:30:00.000Z",
      };
      return Response.json(GetAiConnectionResponse.parse(connection));
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function renderGeneral() {
  const Page = GeneralRoute.options.component as ComponentType;
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Page />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** Open the AI model row, choose Change, then Anthropic, and start the Claude plan's sign-in. */
async function startClaude(view: ReturnType<typeof renderGeneral>) {
  await userEvent.click(
    await view.findByRole("button", { name: /Uses your OpenAI API key/ }),
  );
  const dialog = await view.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Change" }));
  await userEvent.click(
    await within(dialog).findByRole("button", { name: /^Anthropic/ }),
  );
  // Inside Desktop the plan is offered, first, as at setup.
  await userEvent.click(
    await within(dialog).findByRole("button", {
      name: "Sign in with Anthropic",
    }),
  );
  return dialog;
}

/** Sign in with the Claude plan: approved in the browser, which comes back to Desktop. */
async function signInWithClaude(view: ReturnType<typeof renderGeneral>) {
  const dialog = await startClaude(view);
  await within(dialog).findByText("Signed in to Anthropic.");
  return dialog;
}

test("a Claude plan: signed in, its engine started alone, the server switched, Desktop settled, and OpenBot never stopped", async () => {
  const view = renderGeneral();
  const dialog = await signInWithClaude(view);
  // Nothing to paste: the sign-in finished on its own.
  expect(within(dialog).queryByLabelText("Code from your browser")).toBeNull();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );
  await within(dialog).findByText("Connected to Anthropic");

  const asked = aiCalls();
  expect(asked.map((call) => call.what)).toEqual([
    "ai_providers",
    "begin_plan_sign_in",
    "finish_plan_sign_in",
    "prepare_ai_connection",
    "replaceAiConnection",
    "settle_ai_connection",
  ]);
  expect(asked[1]?.args).toEqual({ plan: "claude", redirect: "loopback" });
  expect(asked[2]?.args).toEqual({ plan: "claude" });
  expect(asked[3]?.args).toEqual({ provider: "anthropic", login: "plan" });
  expect(asked[4]?.args).toEqual({ provider: "anthropic", login: "plan" });
  expect(asked[5]?.args).toEqual({ provider: "anthropic", login: "plan" });
  expect(calls.map((call) => call.what)).not.toContain("change_ai_connection");
});

/**
 * A Desktop older than Claude's loopback sign-in ignores `redirect` and sends Claude's code page:
 * the page keeps its paste box, and finishes with the code the person brings back.
 */
test("a Claude plan in an older Desktop: the code Claude's page shows is pasted, as before", async () => {
  claudeUrl = MANUAL;
  const view = renderGeneral();
  const dialog = await startClaude(view);
  await userEvent.type(
    await within(dialog).findByLabelText("Code from your browser"),
    "code#state",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Finish" }));
  await within(dialog).findByText("Signed in to Anthropic.");
  const asked = aiCalls();
  expect(asked.map((call) => call.what)).toEqual([
    "ai_providers",
    "begin_plan_sign_in",
    "finish_plan_sign_in",
  ]);
  expect(asked[2]?.args).toEqual({ plan: "claude", code: "code#state" });
});

/** The rule that picks between the two, read off the address Desktop answered. */
test("a Claude sign-in finishes in Desktop only when its redirect comes back to this computer", () => {
  expect(finishesInDesktop(LOOPBACK)).toBe(true);
  expect(
    finishesInDesktop(claudeAuthorize("http://127.0.0.1:53682/callback")),
  ).toBe(true);
  expect(finishesInDesktop(MANUAL)).toBe(false);
  // What a Desktop before both answered in tests: no redirect named at all.
  expect(finishesInDesktop("https://claude.ai/oauth/authorize?code=true")).toBe(
    false,
  );
  expect(
    finishesInDesktop(claudeAuthorize("https://localhost.example/callback")),
  ).toBe(false);
  expect(finishesInDesktop("not an address")).toBe(false);
});

test("a refused switch says why in one sentence, and Desktop settles back to the connection still in use", async () => {
  refuse = true;
  const view = renderGeneral();
  const dialog = await signInWithClaude(view);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toBe(
    "Claude hasn't started yet. Try again in a moment.",
  );
  await waitFor(() =>
    expect(aiCalls().at(-1)).toEqual({
      what: "settle_ai_connection",
      args: { provider: "openai", login: "api-key" },
    }),
  );
  expect(calls.map((call) => call.what)).not.toContain("change_ai_connection");
});

test("after a switch, the models a person may pick and each conversation's pick are read again", async () => {
  queryClient.setQueryData(modelKeys.catalogue, { models: [] });
  queryClient.setQueryData(modelKeys.conversation("channel-1"), {
    model: "gpt-6.1-pro",
    effort: null,
  });
  const view = renderGeneral();
  const dialog = await signInWithClaude(view);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Connect" }),
  );
  await within(dialog).findByText("Connected to Anthropic");
  expect(queryClient.getQueryState(modelKeys.catalogue)?.isInvalidated).toBe(
    true,
  );
  expect(
    queryClient.getQueryState(modelKeys.conversation("channel-1"))
      ?.isInvalidated,
  ).toBe(true);
  // And the row under the dialog reads the new connection.
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await view.findByRole("button", { name: /Signed in with your Claude plan/ });
});
