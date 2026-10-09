import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ManageSection } from "@/components/bot-profile/manage";
import type { AgentProfile } from "@/lib/agents/queries";
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
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const requests: string[] = [];
function serving() {
  requests.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).endsWith("/duplicate")) {
      return Response.json({ agent: { ...BOT, id: "expenses-copy" } });
    }
    return Response.json({ agent: BOT });
  }) as unknown as typeof fetch;
}

function draw(
  agent: AgentProfile,
  handlers: {
    onHidden?: () => void;
    onDuplicated?: (copyId: string) => void;
    onDeleted?: () => void;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
});

test("unhiding a hidden Bot keeps the person on its page", async () => {
  serving();
  const onHidden = mock(() => {});
  const view = draw({ ...BOT, hidden: true }, { onHidden });
  fireEvent.click(view.getByRole("switch", { name: "Hidden" }));
  await waitFor(() =>
    expect(requests.some((request) => request.startsWith("POST"))).toBe(true),
  );
  // Let the mutation settle before asserting nothing navigated.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onHidden).not.toHaveBeenCalled();
});

test("duplicating opens the copy", async () => {
  serving();
  const onDuplicated = mock((_copyId: string) => {});
  const view = draw(BOT, { onDuplicated });
  fireEvent.click(view.getByRole("button", { name: /Duplicate/ }));
  await waitFor(() =>
    expect(onDuplicated).toHaveBeenCalledWith("expenses-copy"),
  );
});

test("a Bot an administrator assigned to you reads as pinned and cannot be hidden or unpinned", () => {
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
    view.getAllByText(/Assigned to you by an administrator/).length,
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
