import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TellItWhen } from "@/components/bot-profile/tell-it-when";
import * as StartModule from "@/lib/channels/start";
import { settleReactWork } from "./settle-react-work";

/**
 * "Tell {Bot} when to work": one sentence typed in the Bot's settings, sent as the first message of
 * a new conversation with that Bot. Send waits for a sentence, and a start that fails keeps it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const SENTENCE = "Every weekday at 9, send me yesterday's new leads.";
const FAILED = "Couldn't start the conversation. Try again in a moment.";

async function renderTellItWhen(start: (...args: unknown[]) => Promise<void>) {
  const hook = spyOn(StartModule, "useStartChannel").mockReturnValue({
    start,
  } as unknown as ReturnType<typeof StartModule.useStartChannel>);
  const queryClient = new QueryClient();
  const rootRoute = createRootRoute({
    component: () => <TellItWhen agent={{ id: "b1", name: "Scout" }} />,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const box = await view.findByLabelText("Tell Scout when to work");
  return {
    box,
    findAlert: () => view.findByRole("alert"),
    hook,
    send: view.getByRole("button", { name: "Send" }),
  };
}

test("Send is disabled until something is written", async () => {
  const { box, hook, send } = await renderTellItWhen(mock(async () => {}));
  try {
    expect(box.getAttribute("placeholder")).toBe(SENTENCE);
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(box, "   ");
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(box, "Mondays");
    expect((send as HTMLButtonElement).disabled).toBe(false);
  } finally {
    hook.mockRestore();
  }
});

test("Send starts a conversation with the Bot holding the sentence", async () => {
  const start = mock(async (..._args: unknown[]) => {});
  const { box, hook, send } = await renderTellItWhen(start);
  try {
    await userEvent.type(box, `  ${SENTENCE}  `);
    await userEvent.click(send);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith("b1", SENTENCE);
    // Back from the new conversation returns to the Bot's settings, so the page stays in history.
    expect(hook).toHaveBeenCalledWith({ replace: false });
  } finally {
    hook.mockRestore();
  }
});

test("a start that fails keeps the sentence and says so", async () => {
  const start = mock(async (..._args: unknown[]) => {
    throw new Error("boom");
  });
  const { box, findAlert, hook, send } = await renderTellItWhen(start);
  try {
    await userEvent.type(box, SENTENCE);
    await userEvent.click(send);
    const alert = await findAlert();
    expect(alert.textContent).toBe(FAILED);
    expect((box as HTMLTextAreaElement).value).toBe(SENTENCE);
  } finally {
    hook.mockRestore();
  }
});
