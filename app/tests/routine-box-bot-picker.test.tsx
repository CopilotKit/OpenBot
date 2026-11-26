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
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BOX_BOT_KEY,
  BoxBotPicker,
  NoBotsYet,
  useBoxBot,
} from "@/components/routines/box-bot-picker";
import { queryClient } from "@/query-client";
import { answerBotsList } from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/** The Routines box's Bot picker: which Bot it starts on, what it remembers, and the no-Bots message. */

beforeAll(() => GlobalRegistrator.register());
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function bot(id: string, name: string) {
  return { id, name };
}

function serving(visible: unknown[]) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    answerBotsList(input, init, { visible }) ??
    Response.json({})) as unknown as typeof fetch;
}

function Harness() {
  const box = useBoxBot();
  return (
    <BoxBotPicker
      bots={box.bots ?? []}
      disabled={false}
      onChange={box.pick}
      value={box.bot?.id ?? null}
    />
  );
}

function draw(node: React.ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => node }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const TWO = () => serving([bot("bot-1", "Atlas"), bot("bot-2", "Nova")]);

test("with nothing stored, the picker reads the first Bot", async () => {
  TWO();
  const view = draw(<Harness />);
  const trigger = await view.findByRole("combobox", { name: "Bot" });
  await waitFor(() => expect(trigger.textContent).toContain("Atlas"));
});

test("it reads the Bot stored last, and the first when that one isn't listed", async () => {
  TWO();
  window.localStorage.setItem(BOX_BOT_KEY, "bot-2");
  const view = draw(<Harness />);
  const trigger = await view.findByRole("combobox", { name: "Bot" });
  await waitFor(() => expect(trigger.textContent).toContain("Nova"));
  cleanup();

  window.localStorage.setItem(BOX_BOT_KEY, "gone");
  const again = draw(<Harness />);
  const next = await again.findByRole("combobox", { name: "Bot" });
  await waitFor(() => expect(next.textContent).toContain("Atlas"));
});

test("picking a Bot writes it under the box's key", async () => {
  TWO();
  const view = draw(<Harness />);
  const trigger = await view.findByRole("combobox", { name: "Bot" });
  await waitFor(() => expect(trigger.textContent).toContain("Atlas"));
  const user = userEvent.setup({ document });
  await user.click(trigger);
  await user.click(await view.findByRole("option", { name: "Nova" }));
  await waitFor(() => expect(trigger.textContent).toContain("Nova"));
  expect(window.localStorage.getItem(BOX_BOT_KEY)).toBe("bot-2");
});

test("a store that throws reads as nothing stored and still lets a pick show", async () => {
  TWO();
  const getItem = Storage.prototype.getItem;
  const setItem = Storage.prototype.setItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  Storage.prototype.setItem = () => {
    throw new Error("blocked");
  };
  try {
    const view = draw(<Harness />);
    const trigger = await view.findByRole("combobox", { name: "Bot" });
    await waitFor(() => expect(trigger.textContent).toContain("Atlas"));
    const user = userEvent.setup({ document });
    await user.click(trigger);
    await user.click(await view.findByRole("option", { name: "Nova" }));
    await waitFor(() => expect(trigger.textContent).toContain("Nova"));
  } finally {
    Storage.prototype.getItem = getItem;
    Storage.prototype.setItem = setItem;
  }
});

test("with no Bots, the box says to make one and links to New Bot", async () => {
  const view = draw(<NoBotsYet />);
  expect(
    await view.findByText("Make a Bot first to give it routines."),
  ).toBeTruthy();
  const link = view.getByRole("button", { name: "New Bot" });
  expect(link.getAttribute("href")).toBe("/bots?new=true");
});
