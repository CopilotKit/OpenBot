import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
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
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import { getGetBotDelegationMockHandler } from "@/lib/api/generated/agents/agents.msw";
import {
  getGetBotMockHandler,
  getUpdateBotMockHandler,
} from "@/lib/api/generated/bots/bots.msw";
import type { UpdateBotRequest } from "@/lib/api/generated/model";
import { offeredBotDefault } from "@/lib/models/effort";
import type { CatalogueConnection, ModelCatalogue } from "@/lib/models/queries";
import { queryClient } from "@/query-client";
import { catalogueBody } from "./models-api";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));
// After the stub: a static import is hoisted and would load the real marks module first.
const { SetupSections } = await import("@/components/bot-profile/setup");

/**
 * Whoever manages a Bot on OpenBot's model sets the model its new conversations start on, from
 * Setup, and can put it back on OpenBot's default.
 *
 * The server is the spec's own: the MSW handlers Orval generates beside the client. The PATCH
 * handler keeps the default it was sent, stamped with the catalogue's source as the server stamps
 * it, and the GET answers with it, so the row is the screen reading the saved default back.
 */

const catalogue: ModelCatalogue = {
  provider: "openai",
  source: "openai",
  exposure: "all",
  default: "gpt-5.5",
  choosable: true,
  models: [
    {
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      vendor: "openai",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
  ],
};

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: true,
  keyFromOpenBot: false,
  id: "research-bot",
  name: "Research Bot",
  title: "Research",
  roleDescription: "Researches a topic.",
  avatarSeed: "research-bot",
  visibility: "private",
  endpoint: null,
  builtIn: false,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
  defaultModel: null,
};

let stored: AgentProfile = BOT;
/** What the catalogue answers: one connection, or several (`connections`). */
let served: ModelCatalogue = catalogue;
let patches: UpdateBotRequest[] = [];

const server = setupServer(
  http.get("*/api/v2/organizations/:organizationId/model-catalogue", () =>
    HttpResponse.json(catalogueBody(served)),
  ),
  // The Bot answers itself, so a conversation with it takes a model.
  getGetBotDelegationMockHandler(),
  getGetBotMockHandler(() => ({ bot: stored })),
  getUpdateBotMockHandler(async ({ request }) => {
    const body = await request.json();
    patches.push(body);
    stored = {
      ...stored,
      // Absent leaves it as it is; null puts the Bot back on OpenBot's default.
      ...(body.defaultModel === undefined
        ? {}
        : {
            defaultModel: body.defaultModel
              ? { source: served.source, ...body.defaultModel }
              : null,
          }),
    };
    return { bot: stored };
  }),
  // Everything else Setup asks for is not this test's business, and is not found.
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
  served = catalogue;
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

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

async function modelSection(view: ReturnType<typeof draw>) {
  const heading = await view.findByRole("heading", { name: "Model" });
  const section = heading.closest("section") ?? heading.parentElement;
  if (!section) throw new Error("no Model section");
  return within(section as HTMLElement);
}

async function chooseAndSave(view: ReturnType<typeof draw>, option: RegExp) {
  const row = await (await modelSection(view)).findByRole("button", {
    name: /Default model/,
  });
  fireEvent.click(row);
  const dialog = within(await view.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("radio", { name: option }));
  await act(async () => {
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  });
  await settleReactWork();
}

test("a Bot's default model is set on Setup, read back, and put back on OpenBot's default", async () => {
  const view = draw(BOT);
  expect(
    await (await modelSection(view)).findByText(
      "OpenBot's default · GPT-5.5 · Medium",
    ),
  ).toBeTruthy();

  await chooseAndSave(view, /^Choose a model for this Bot/);
  expect(patches).toHaveLength(1);
  // The rest of the Bot goes with it unchanged, and the default is the model the field showed.
  expect(patches[0]).toMatchObject({
    name: BOT.name,
    defaultModel: { model: "gpt-5.5", effort: null },
  });
  expect(view.queryByRole("dialog")).toBeNull();
  expect(
    await (await modelSection(view)).findByText("GPT-5.5 · Medium"),
  ).toBeTruthy();

  await chooseAndSave(view, /^Use OpenBot's default/);
  expect(patches).toHaveLength(2);
  expect(patches[1]?.defaultModel).toBeNull();
  expect(
    await (await modelSection(view)).findByText(
      "OpenBot's default · GPT-5.5 · Medium",
    ),
  ).toBeTruthy();
});

test("a saved default the catalogue no longer offers says new conversations use OpenBot's default", async () => {
  const view = draw({
    ...BOT,
    defaultModel: { model: "gpt-4-retired", effort: null, source: "openai" },
  });
  expect(
    await (await modelSection(view)).findByText(
      "The chosen model isn't available. New conversations use OpenBot's default.",
    ),
  ).toBeTruthy();
});

/*
 * Several AI connections (plans/multiple-ai-connections-spec.md, step 5). A Bot is shared and each
 * person runs it on their own connections, so its default names a kind of connection (`source`),
 * not one connection: it applies for a person with a connection of that kind that can run.
 */
const OPUS = {
  id: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  vendor: "anthropic",
};
const SONNET = {
  id: "claude-sonnet-5-5",
  label: "Claude Sonnet 5.5",
  vendor: "anthropic",
};
const CHATGPT: CatalogueConnection = {
  id: "openai",
  owner: "personal",
  provider: "openai",
  login: "api-key",
  source: "openai",
  isDefault: true,
  ready: true,
  problem: null,
  default: "gpt-5.5",
  models: catalogue.models,
  listed: true,
};
const CLAUDE: CatalogueConnection = {
  ...CHATGPT,
  id: "anthropic",
  provider: "anthropic",
  login: "plan",
  source: "claude",
  isDefault: false,
  default: OPUS.id,
  models: [OPUS, SONNET],
};
const SEVERAL: ModelCatalogue = {
  ...catalogue,
  connections: [CHATGPT, CLAUDE],
};

test("a Bot default of another kind than the default connection applies when that kind is connected and ready", async () => {
  expect(
    offeredBotDefault(
      { model: OPUS.id, effort: null, source: "claude" },
      SEVERAL,
    ),
  ).toEqual({ model: OPUS.id, effort: null, connection: "anthropic" });
  served = SEVERAL;
  const view = draw({
    ...BOT,
    defaultModel: { model: OPUS.id, effort: null, source: "claude" },
  });
  expect(await (await modelSection(view)).findByText(OPUS.label)).toBeTruthy();
});

test("a Bot default whose kind is connected but stopped falls back to the default connection", () => {
  const stopped: ModelCatalogue = {
    ...SEVERAL,
    connections: [
      CHATGPT,
      {
        ...CLAUDE,
        ready: false,
        problem: { code: "sign-in-ended", detail: "Sign in again." },
      },
    ],
  };
  expect(
    offeredBotDefault(
      { model: OPUS.id, effort: null, source: "claude" },
      stopped,
    ),
  ).toBeUndefined();
});

test("a Bot default whose kind is not connected falls back, as today", () => {
  expect(
    offeredBotDefault(
      { model: OPUS.id, effort: null, source: "claude" },
      { ...catalogue, connections: [CHATGPT] },
    ),
  ).toBeUndefined();
  expect(
    offeredBotDefault(
      { model: OPUS.id, effort: null, source: "claude" },
      catalogue,
    ),
  ).toBeUndefined();
});

test("saving from the second group sends its source; with one connection none is sent", async () => {
  served = SEVERAL;
  const view = draw(BOT);
  const row = await (await modelSection(view)).findByRole("button", {
    name: /Default model/,
  });
  fireEvent.click(row);
  const dialog = within(await view.findByRole("dialog"));
  fireEvent.click(dialog.getByRole("radio", { name: /^Choose a model/ }));
  const user = userEvent.setup({ document });
  await user.click(await dialog.findByRole("combobox", { name: /Model:/ }));
  const popups = await view.findAllByRole("dialog");
  const popup = within(popups[popups.length - 1] as HTMLElement);
  await user.click(popup.getByRole("option", { name: /Claude Sonnet 5.5/ }));
  await act(async () => {
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  });
  await settleReactWork();
  expect(patches[0]?.defaultModel).toEqual({
    model: SONNET.id,
    effort: null,
    source: "claude",
  });

  cleanup();
  queryClient.clear();
  patches = [];
  served = catalogue;
  const one = draw(BOT);
  await chooseAndSave(one, /^Choose a model for this Bot/);
  expect(patches[0]?.defaultModel).toEqual({ model: "gpt-5.5", effort: null });
});

test("someone who can't manage the Bot reads its default model and can't change it", async () => {
  const view = draw({
    ...BOT,
    canManage: false,
    mine: false,
    defaultModel: { model: "gpt-6.1-terra", effort: "high", source: "openai" },
  });
  const section = await modelSection(view);
  expect(await section.findByText("GPT-6.1 Terra · High")).toBeTruthy();
  expect(section.queryByRole("button", { name: /Default model/ })).toBeNull();
});
