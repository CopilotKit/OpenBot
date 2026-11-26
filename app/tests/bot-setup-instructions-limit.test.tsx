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
import { agentFormSchema } from "@/lib/agents/form";
import { type AgentProfile, agentQueryOptions } from "@/lib/agents/queries";
import {
  getGetBotMockHandler,
  getUpdateBotMockHandler,
} from "@/lib/api/generated/bots/bots.msw";
import {
  updateBotBodyOneInstructionsMax,
  updateBotBodyOneRoleDescriptionMax,
} from "@/lib/api/generated/bots/bots.zod";
import type { UpdateBotRequest } from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's instructions run to 5000 characters on its Setup page.
 *
 * Seen dogfooding: instructions were capped at 1000 characters, which cut short the standing rules
 * a person wrote for a Bot. "What it does" is what a Bot made in OpenBot runs on, so it is its
 * instructions; the starter Bot's own Instructions row takes the same.
 *
 * The server is the spec's own: the MSW handlers Orval generates beside the client. The PATCH
 * handler keeps what it was sent and the GET answers with it.
 */

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: true,
  keyFromOpenBot: false,
  id: "expense-review",
  name: "Expense Review",
  title: "Finance",
  roleDescription: "Review receipts.",
  avatarSeed: "expense-review",
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
};

/** Typing 10,000 characters a key at a time takes seconds on a busy runner. */
const TYPING = 60_000;

let stored: AgentProfile = BOT;
let patches: UpdateBotRequest[] = [];

const server = setupServer(
  getGetBotMockHandler(() => ({ bot: stored })),
  getUpdateBotMockHandler(async ({ request }) => {
    const body = await request.json();
    patches.push(body);
    stored = {
      ...stored,
      roleDescription: body.roleDescription,
      ...(body.instructions === undefined
        ? {}
        : { instructions: body.instructions }),
    };
    return { bot: stored };
  }),
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

/** Open a row's dialog, type `value` in place of what its field holds, and press Save. */
async function save(
  view: ReturnType<typeof draw>,
  row: RegExp,
  label: string,
  value: string,
) {
  fireEvent.click(await view.findByRole("button", { name: row }));
  const dialog = await view.findByRole("dialog");
  const field = within(dialog).getByLabelText(label);
  const user = userEvent.setup({ document: field.ownerDocument, delay: null });
  await user.clear(field);
  await user.type(field, value);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  });
  await settleReactWork();
  return dialog;
}

test("the form holds a Bot's instructions to the API's limit", () => {
  expect(updateBotBodyOneRoleDescriptionMax).toBe(5000);
  expect(updateBotBodyOneInstructionsMax).toBe(5000);
  const { roleDescription, instructions } = agentFormSchema.shape;
  for (const field of [roleDescription, instructions.unwrap()]) {
    expect(field.safeParse("r".repeat(4999)).success).toBe(true);
    expect(field.safeParse("r".repeat(5000)).success).toBe(true);
    expect(field.safeParse("r".repeat(5001)).success).toBe(false);
  }
});

test(
  "What it does saves 5000 characters, and 5001 is refused with nothing sent",
  async () => {
    const view = draw(BOT);
    const most = `${"Check every receipt. ".repeat(238)}Done.`.slice(0, 5000);
    expect(most).toHaveLength(5000);

    const tooLong = await save(
      view,
      /^What it does/,
      "What it does",
      `${most}!`,
    );
    expect(within(tooLong).getByRole("alert").textContent).toBe(
      "What it does must be 5000 characters or fewer.",
    );
    expect(patches).toEqual([]);
    fireEvent.click(within(tooLong).getByRole("button", { name: "Cancel" }));
    await settleReactWork();

    await save(view, /^What it does/, "What it does", most);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.roleDescription).toBe(most);
    expect(stored.roleDescription).toBe(most);
  },
  TYPING,
);

test(
  "the starter Bot's Instructions save 5000 characters, and 5001 is refused",
  async () => {
    const view = draw({ ...BOT, instructions: "Help with everyday work." });
    const most = "i".repeat(5000);

    const tooLong = await save(
      view,
      /^Instructions/,
      "Instructions",
      `${most}i`,
    );
    expect(within(tooLong).getByRole("alert").textContent).toBe(
      "Instructions must be 5000 characters or fewer.",
    );
    expect(patches).toEqual([]);
    fireEvent.click(within(tooLong).getByRole("button", { name: "Cancel" }));
    await settleReactWork();

    await save(view, /^Instructions/, "Instructions", most);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.instructions).toBe(most);
  },
  TYPING,
);
