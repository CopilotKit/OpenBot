import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { SetupSections } from "@/components/bot-profile/setup";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import {
  getGetBotMockHandler,
  getUpdateBotMockHandler,
} from "@/lib/api/generated/bots/bots.msw";
import type { UpdateBotRequest } from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot that runs at an address of its own can be moved to another from its Setup page.
 *
 * Reported from dogfooding: the Agent URL row was a plain value with no way to change it, while the
 * page says it edits the Bot's runtime settings. The update API already took a new endpoint; only
 * the screen was missing.
 *
 * The server is the spec's own: the MSW handlers Orval generates beside the client, at the API's
 * addresses. The PATCH handler keeps what it was sent and the GET answers with it, so the row
 * showing the new address is the screen reading it back, not the screen remembering what it typed.
 * Its endpoint check is the server's: a private address is refused with the server's own sentence,
 * as a deployment that keeps Bots off its network refuses it.
 */

const PRIVATE_REFUSAL =
  "That address is inside OpenBot's own network, so an agent may not live there.";

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "sales-assistant",
  name: "Sales Assistant",
  title: "Sales",
  roleDescription: "Answers questions about the pipeline.",
  avatarSeed: "sales-assistant",
  visibility: "private",
  endpoint: "https://agents.example.com/ag-ui",
  builtIn: false,
  hasAuth: true,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

/** The Bot as the server holds it, and every body a PATCH sent it. */
let stored: AgentProfile = BOT;
let patches: UpdateBotRequest[] = [];

/** The server's endpoint check, as a hosted deployment runs it: no private addresses. */
function isPrivate(endpoint: string): boolean {
  const host = new URL(endpoint).hostname;
  return (
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.")
  );
}

const server = setupServer(
  /*
   * The server's refusal, as the API answers one: problem details carrying its sentence. The
   * generated handler below only answers 200, so a refused body is answered here first, and any
   * other falls through to it.
   */
  http.patch(
    "*/api/v2/organizations/:organizationId/bots/:botId",
    async ({ request }) => {
      const body = (await request.clone().json()) as UpdateBotRequest;
      if (!body.endpoint || !isPrivate(body.endpoint)) return undefined;
      patches.push(body);
      return HttpResponse.json(
        {
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          code: "VALIDATION_ERROR",
          detail: PRIVATE_REFUSAL,
        },
        {
          status: 400,
          headers: { "content-type": "application/problem+json" },
        },
      );
    },
  ),
  getGetBotMockHandler(() => ({ bot: stored })),
  getUpdateBotMockHandler(async ({ request }) => {
    const body = await request.json();
    patches.push(body);
    stored = {
      ...stored,
      name: body.name,
      // Empty or absent leaves the stored address as it is.
      ...(body.endpoint ? { endpoint: body.endpoint } : {}),
    };
    return { bot: stored };
  }),
  // Everything else the section asks for is not this test's business, and is not found.
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  stored = BOT;
  patches = [];
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The Setup sections as the Setup page draws them: from the Bot the server returns. */
function SetupOf({ botId }: { botId: string }) {
  const bot = useQuery(agentQueryOptions(botId));
  return bot.data ? <SetupSections agent={bot.data} /> : null;
}

function draw(bot: AgentProfile) {
  stored = bot;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <SetupOf botId={bot.id} />,
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function connection(view: ReturnType<typeof draw>) {
  const heading = await view.findByRole("heading", { name: "Connection" });
  const section = heading.closest("section") ?? heading.parentElement;
  if (!section) throw new Error("no Connection section");
  return within(section as HTMLElement);
}

/** A person replacing what the field holds, one key at a time, then pressing Save. */
async function replaceAndSave(field: HTMLElement, value: string) {
  const user = userEvent.setup({ document: field.ownerDocument });
  await user.clear(field);
  if (value) await user.type(field, value);
  await act(async () => {
    fireEvent.click(
      within(field.closest("[role=dialog]") as HTMLElement).getByRole(
        "button",
        { name: "Save" },
      ),
    );
  });
  await settleReactWork();
}

test("whoever manages a Bot changes its Agent URL on Setup, and the row shows what the server saved", async () => {
  const view = draw(BOT);
  const section = await connection(view);

  fireEvent.click(section.getByRole("button", { name: /Agent URL/ }));
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("Agent URL")).toBeTruthy();
  const field = within(dialog).getByLabelText("Agent URL");
  expect((field as HTMLInputElement).value).toBe(BOT.endpoint ?? "");
  expect(field.getAttribute("type")).toBe("url");

  await replaceAndSave(field, "https://agents.example.com/v2/ag-ui");

  // One write, to the Bot's own address, carrying the new endpoint and leaving its key alone.
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({
    name: BOT.name,
    endpoint: "https://agents.example.com/v2/ag-ui",
  });
  expect(patches[0]?.auth).toBeUndefined();
  expect(view.queryByRole("dialog")).toBeNull();
  expect(
    await (await connection(view)).findByText(
      "https://agents.example.com/v2/ag-ui",
    ),
  ).toBeTruthy();
});

test("an address the server refuses is shown in the dialog, and nothing changes", async () => {
  const view = draw(BOT);
  fireEvent.click(
    (await connection(view)).getByRole("button", { name: /Agent URL/ }),
  );
  const dialog = await view.findByRole("dialog");
  const field = within(dialog).getByLabelText("Agent URL");

  await replaceAndSave(field, "http://10.0.0.7:8000/ag-ui");

  const alert = within(dialog).getByRole("alert");
  expect(alert.textContent).toBe(PRIVATE_REFUSAL);
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  // The dialog stays open with what was typed, and the Bot keeps its address.
  expect((field as HTMLInputElement).value).toBe("http://10.0.0.7:8000/ag-ui");
  expect(stored.endpoint).toBe(BOT.endpoint);
});

test("an address that is not a web address, or none, is refused before anything is sent", async () => {
  const view = draw(BOT);
  fireEvent.click(
    (await connection(view)).getByRole("button", { name: /Agent URL/ }),
  );
  const dialog = await view.findByRole("dialog");
  const field = within(dialog).getByLabelText("Agent URL");

  for (const typed of ["agents.example.com/ag-ui", ""]) {
    await replaceAndSave(field, typed);
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Enter a web address starting with http:// or https://.",
    );
  }
  expect(patches).toEqual([]);
});

test("the same address saved back sends nothing", async () => {
  const view = draw(BOT);
  fireEvent.click(
    (await connection(view)).getByRole("button", { name: /Agent URL/ }),
  );
  const dialog = await view.findByRole("dialog");
  await replaceAndSave(
    within(dialog).getByLabelText("Agent URL"),
    BOT.endpoint ?? "",
  );
  expect(patches).toEqual([]);
  expect(view.queryByRole("dialog")).toBeNull();
});

test("the Agent URL is read-only to anyone who can't manage the Bot, and Built in stays as it is", async () => {
  const view = draw({ ...BOT, canManage: false, mine: false });
  const section = await connection(view);
  expect(section.getByText(BOT.endpoint ?? "")).toBeTruthy();
  expect(section.queryByRole("button", { name: /Agent URL/ })).toBeNull();
  cleanup();
  queryClient.clear();

  const builtIn = draw({ ...BOT, endpoint: null, builtIn: true });
  const builtInSection = await connection(builtIn);
  expect(builtInSection.getByText("Built in")).toBeTruthy();
  expect(builtInSection.queryAllByRole("button")).toEqual([]);
});

test("renaming a Bot whose stored address the rules now refuse does not send that address to be checked again", async () => {
  // Saved before the deployment closed private addresses: still stored, and refused if sent again.
  const local = { ...BOT, endpoint: "http://127.0.0.1:8000/ag-ui" };
  const view = draw(local);
  fireEvent.click(await view.findByRole("button", { name: /^Name/ }));
  const dialog = await view.findByRole("dialog");

  await replaceAndSave(within(dialog).getByLabelText("Name"), "Sales Desk");

  expect(within(view.baseElement).queryByRole("alert")).toBeNull();
  expect(patches).toHaveLength(1);
  // Empty leaves the stored address where it is (api/openapi.yaml, BotEndpoint).
  expect(patches[0]).toMatchObject({ name: "Sales Desk", endpoint: "" });
  expect(stored.endpoint).toBe(local.endpoint);
});
