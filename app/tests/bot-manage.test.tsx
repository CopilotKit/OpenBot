import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ManageSection } from "@/components/bot-profile/manage";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ResetPlan } from "@/lib/bot-lifecycle/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  botOperationPath,
  botResponse,
  resetResponse,
  type SentRequest,
  sentRequest,
} from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * What can be done to a Bot from its own page. Navigation is the page's, so the section reports
 * where to go through callbacks, and these tests assert on those.
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
});

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Review receipts.",
  avatarSeed: "expenses",
  visibility: "private",
  endpoint: null,
  builtIn: true,
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

const requests: SentRequest[] = [];
function serving() {
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = sentRequest(input, init);
    requests.push(sent);
    if (sent.path === botOperationPath(BOT.id, "duplicate")) {
      return botResponse({ ...BOT, id: "expenses-copy" }, 201);
    }
    return botResponse(BOT);
  }) as unknown as typeof fetch;
}

/** The one write a press sent: a POST to the operation's address, with a key of its own. */
function expectOneWrite(path: string) {
  const writes = requests.filter((request) => request.method !== "GET");
  expect(writes).toEqual([
    {
      method: "POST",
      path,
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: undefined,
    },
  ]);
}

function draw(
  agent: AgentProfile,
  handlers: {
    onHidden?: () => void;
    onDuplicated?: (copyId: string) => void;
    onDeleted?: () => void;
  } = {},
  edition?: "team" | "personal",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (edition) {
    client.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: edition === "personal",
      edition,
    });
  }
  return render(
    <QueryClientProvider client={client}>
      <ManageSection
        agent={agent}
        onDeleted={handlers.onDeleted ?? (() => {})}
        onDuplicated={handlers.onDuplicated ?? (() => {})}
        onHidden={handlers.onHidden ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

test("someone who cannot manage the Bot is not offered Delete", () => {
  const view = draw({ ...BOT, canManage: false, mine: false });
  expect(view.queryByText("Delete")).toBeNull();
  expect(view.getByText("Duplicate")).toBeTruthy();
});

test("hiding a Bot takes the person back to the roster", async () => {
  serving();
  const onHidden = mock(() => {});
  const view = draw(BOT, { onHidden });
  fireEvent.click(view.getByRole("switch", { name: "Hidden" }));
  await waitFor(() => expect(onHidden).toHaveBeenCalledTimes(1));
  expectOneWrite(botOperationPath("expenses", "hide"));
});

test("unhiding a hidden Bot keeps the person on its page", async () => {
  serving();
  const onHidden = mock(() => {});
  const view = draw({ ...BOT, hidden: true }, { onHidden });
  fireEvent.click(view.getByRole("switch", { name: "Hidden" }));
  await waitFor(() =>
    expect(requests.some((request) => request.method === "POST")).toBe(true),
  );
  // Let the mutation settle before asserting nothing navigated.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onHidden).not.toHaveBeenCalled();
  expectOneWrite(botOperationPath("expenses", "unhide"));
});

test("pinning and unpinning a Bot are the API's pin and unpin", async () => {
  serving();
  const view = draw(BOT);
  fireEvent.click(view.getByRole("switch", { name: "Pinned" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expectOneWrite(botOperationPath("expenses", "pin"));
  cleanup();

  serving();
  const pinned = draw({ ...BOT, pinned: true });
  fireEvent.click(pinned.getByRole("switch", { name: "Pinned" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expectOneWrite(botOperationPath("expenses", "unpin"));
});

test("duplicating opens the copy", async () => {
  serving();
  const onDuplicated = mock((_copyId: string) => {});
  const view = draw(BOT, { onDuplicated });
  fireEvent.click(view.getByRole("button", { name: /Duplicate/ }));
  await waitFor(() =>
    expect(onDuplicated).toHaveBeenCalledWith("expenses-copy"),
  );
  expectOneWrite(botOperationPath("expenses", "duplicate"));
});

test("a Bot an admin assigned to you reads as pinned and cannot be hidden or unpinned", () => {
  const view = draw({
    ...BOT,
    mine: false,
    canManage: false,
    assignedToMe: true,
  });
  const pinned = view.getByRole("switch", { name: "Pinned" });
  const hidden = view.getByRole("switch", { name: "Hidden" });
  expect(pinned.getAttribute("aria-checked")).toBe("true");
  expect(
    pinned.hasAttribute("disabled") ||
      pinned.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(
    hidden.hasAttribute("disabled") ||
      hidden.getAttribute("aria-disabled") === "true",
  ).toBe(true);
  expect(
    view.getAllByText(/An admin assigned it to you/).length,
  ).toBeGreaterThan(0);
});

test("rows that open a dialog show a chevron, and Duplicate, which acts at once, does not", () => {
  const view = draw(BOT);
  const chevron = (name: RegExp) =>
    view
      .getByRole("button", { name })
      .querySelector(".tabler-icon-chevron-right");
  expect(chevron(/^Reset/)).not.toBeNull();
  expect(chevron(/^Delete/)).not.toBeNull();
  expect(chevron(/^Duplicate/)).toBeNull();
});

/**
 * A reset with a conversation to delete, so the notice lists something. Counting and resetting are
 * the same operation, told apart by `validateOnly`, and each answers the same counts.
 */
function servingResetPlan(plan: Partial<ResetPlan> = { conversations: 1 }) {
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = sentRequest(input, init);
    requests.push(sent);
    const { validateOnly } = sent.body as { validateOnly: boolean };
    return resetResponse(plan, validateOnly);
  }) as unknown as typeof fetch;
}

test("Reset counts what it would delete, then deletes it when asked", async () => {
  servingResetPlan({
    conversations: 2,
    routines: 1,
    sharedConversationsKept: 1,
  });
  const view = draw(BOT, {}, "team");
  fireEvent.click(view.getByRole("button", { name: /^Reset/ }));
  expect(await view.findByText("2 conversations")).toBeTruthy();
  expect(view.getByText("1 routine")).toBeTruthy();
  expect(
    view.getByText(/1 conversation is shared with other people or Bots/),
  ).toBeTruthy();
  const path = botOperationPath("expenses", "reset");
  // Counting deleted nothing: it was the reset, asked only to count.
  expect(requests).toEqual([
    {
      method: "POST",
      path,
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: { validateOnly: true },
    },
  ]);

  fireEvent.click(view.getByRole("button", { name: "Delete and reset" }));
  expect(
    await view.findByText("Done. Expenses starts fresh with you."),
  ).toBeTruthy();
  const reset = requests.find(
    (request) =>
      (request.body as { validateOnly: boolean }).validateOnly === false,
  );
  expect(reset).toEqual({
    method: "POST",
    path,
    key: expect.stringMatching(/^[0-9a-f]{32}$/),
    body: { validateOnly: false },
  });
  expect(reset?.key).not.toBe(requests[0]?.key);
});

/*
 * The personal edition has no memory (see `offersMemory`), so Reset promises none: neither the row
 * nor the notice it opens says the Bot remembers anything for you.
 */
test("Reset promises no memory in the personal edition", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "personal");
  const row = view.getByRole("button", { name: /^Reset/ });
  expect(row.textContent).toContain(
    "Delete your conversations with it and its scheduled work.",
  );
  expect(row.textContent).not.toMatch(/remember|memor/i);
  fireEvent.click(row);
  expect(await view.findByText("1 conversation")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/remember|memor/i);
});

test("Reset still names what a Bot remembers for you in the team edition", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "team");
  const row = view.getByRole("button", { name: /^Reset/ });
  expect(row.textContent).toContain("what it remembers for you");
  fireEvent.click(row);
  expect(await view.findByText("1 conversation")).toBeTruthy();
  expect(
    view.getByText("Memories you told a Bot yourself are kept."),
  ).toBeTruthy();
});

/*
 * The personal edition has one person. Nobody else has a Bots list for "only your list" to set
 * apart, and nobody else for "everyone" to mean. Its Delete says what's true for them: the Bot goes,
 * and its conversations stay readable (channel-chat.tsx: "You can still read this conversation").
 */
test("the personal edition's rows say nothing about other people", async () => {
  const view = draw(BOT, {}, "personal");
  const text = () => document.body.textContent ?? "";
  expect(view.getByText("Keep it at the top of your Bots list.")).toBeTruthy();
  expect(view.getByText("Take it off your Bots list.")).toBeTruthy();
  const remove = view.getByRole("button", { name: /^Delete/ });
  expect(remove.textContent).toContain(
    "Deletes it. You can still read your conversations with it. You can't undo this.",
  );
  expect(text()).not.toMatch(/only your list|for everyone/i);
  fireEvent.click(remove);
  expect(
    await view.findByText(
      "You can still read your conversations with it, but it can't reply. You can't undo this.",
    ),
  ).toBeTruthy();
  expect(text()).not.toMatch(/for everyone|other people/i);
});

test("the personal edition's Reset notice doesn't mention other people's data", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "personal");
  fireEvent.click(view.getByRole("button", { name: /^Reset/ }));
  expect(
    await view.findByText(
      "This deletes what Expenses has with you. You can't undo this.",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/other people/i);
});

test("a hidden or pinned Bot in the personal edition says where it is, and no more", () => {
  const view = draw({ ...BOT, hidden: true, pinned: true }, {}, "personal");
  expect(view.getByText("At the top of your Bots list.")).toBeTruthy();
  expect(view.getByText("Under Hidden on your Bots list.")).toBeTruthy();
});

test("a team deployment keeps saying whose list changes and who a delete reaches", async () => {
  servingResetPlan();
  const view = draw(BOT, {}, "team");
  expect(
    view.getByText(
      "Keep it at the top of your Bots list. Only your list changes.",
    ),
  ).toBeTruthy();
  expect(
    view.getByText("Take it off your Bots list. Only your list changes."),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: /^Delete/ }).textContent).toContain(
    "Deletes it for everyone. You can't undo this.",
  );
  fireEvent.click(view.getByRole("button", { name: /^Reset/ }));
  expect(
    await view.findByText(
      "This deletes what Expenses has with you. Other people's conversations and data stay. You can't undo this.",
    ),
  ).toBeTruthy();
});
