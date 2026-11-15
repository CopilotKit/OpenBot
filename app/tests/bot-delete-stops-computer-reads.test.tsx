import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MutationObserver, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManageSection } from "@/components/bot-profile/manage";
import { deleteAgentMutationOptions } from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { getGetComputerUrl } from "@/lib/api/generated/computers/computers";
import { organizationId } from "@/lib/api/request";
import { queryClient } from "@/query-client";
import { ComputerPane } from "@/skins/opendots/computer-pane";
import {
  answerBotsList,
  BOTS_PATH,
  botPath,
  noContent,
  problemResponse,
} from "./bots-api";
import { pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Delete on a Bot's page stops everything that reads that Bot's computer. With the Computer pane
 * open beside the page, the pane stays on the Bot for a moment after the delete, while the list of
 * Bots is read again, and in that moment it used to ask once more about the Bot's computer (who has
 * control, its screen), which could only answer that the Bot is not found.
 */

let originalFetch: typeof fetch;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
// Prototypes outlive this file: bun runs every test file in one process.
let originalDecode: typeof HTMLImageElement.prototype.decode;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalDecode = HTMLImageElement.prototype.decode;
  // Without an observer the Bot's screen counts as on screen, so it is read as it is when watched.
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  }
  HTMLImageElement.prototype.decode = originalDecode;
  GlobalRegistrator.unregister();
});

function bot(id: string, name: string): AgentProfile {
  return {
    assignedToMe: false,
    runsOnOpenBotModel: false,
    keyFromOpenBot: false,
    id,
    name,
    title: "",
    roleDescription: "Review receipts.",
    avatarSeed: id,
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
}

/** The Bot that is deleted, and one that is not. */
const EXPENSES = bot("expenses", "Expenses");
const SALES = bot("sales", "Sales");

/** Every address of one Bot's computer starts here. */
const computerOf = (botId: string) =>
  getGetComputerUrl(organizationId(), botId);
const isComputerOf = (botId: string, path: string) =>
  path === computerOf(botId) || path.startsWith(`${computerOf(botId)}/`);

/** How long the list of Bots takes to come back after the delete: longer than one poll of a computer. */
const LIST_TAKES_MS = 1_500;

/**
 * The server: both Bots until Expenses is deleted, and a 404 for anything about its computer after,
 * as the real one. It keeps every request for a computer, and which of them came after the delete
 * was asked for.
 */
function serving({ deleteFails = false } = {}) {
  let deleted = false;
  const seen = {
    /** The delete has reached the server. */
    deleteAsked: false,
    /** The delete has been answered. */
    deleteAnswered: false,
    /** The list of Bots, asked for after the delete, has come back. */
    listBackAfterDelete: false,
    /** Requests about the Expenses computer before the delete was asked. */
    expensesBefore: [] as string[],
    /** Requests about the Expenses computer from the moment the delete was asked. */
    expensesAfter: [] as string[],
    /** Requests about the Sales computer once the list had come back. */
    salesAfterList: [] as string[],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === botPath(EXPENSES.id) && method === "DELETE") {
      seen.deleteAsked = true;
      // The server takes a moment over it, so the page is seen while the delete is on its way.
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen.deleteAnswered = true;
      if (deleteFails)
        return problemResponse(409, "This Bot can't be deleted right now.");
      deleted = true;
      return noContent();
    }
    if (isComputerOf(EXPENSES.id, path)) {
      (seen.deleteAsked ? seen.expensesAfter : seen.expensesBefore).push(path);
      if (deleted) return problemResponse(404, "Bot not found.");
      return answerComputer(EXPENSES.id, path);
    }
    if (isComputerOf(SALES.id, path)) {
      if (seen.listBackAfterDelete) seen.salesAfterList.push(path);
      return answerComputer(SALES.id, path);
    }
    if (path === BOTS_PATH && seen.deleteAnswered && !deleteFails) {
      // A real list takes a moment to come back, and the pane is still on the Bot until it does.
      await new Promise((resolve) => setTimeout(resolve, LIST_TAKES_MS));
      const list = answerBotsList(input, init, { visible: [SALES] });
      seen.listBackAfterDelete = true;
      return list as Response;
    }
    const bots = answerBotsList(input, init, { visible: [EXPENSES, SALES] });
    if (bots) return bots;
    return Response.json({});
  }) as unknown as typeof fetch;
  return seen;
}

/** A running computer with a page open and the Bot holding the wheel. */
function answerComputer(botId: string, path: string): Response {
  if (path.endsWith("/control"))
    return Response.json({
      holder: "bot",
      since: new Date(0).toISOString(),
      requested: false,
    });
  if (path.endsWith("/screenshot"))
    return Response.json({
      base64: "AAAA",
      width: 320,
      height: 200,
      capturedAt: new Date(0).toISOString(),
      url: "https://example.com",
    });
  return Response.json({ botId, state: "ready" });
}

/** A Bot's page with the Computer pane open beside it, on that Bot. */
function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ManageSection
        agent={EXPENSES}
        onDeleted={() => {}}
        onDuplicated={() => {}}
        onHidden={() => {}}
      />
      <ComputerPane defaultBotId={EXPENSES.id} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

async function pressDelete(view: ReturnType<typeof draw>) {
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /^Delete/ }));
  const dialog = await view.findByRole("dialog", { name: "Delete Expenses?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
}

test("a deleted Bot's computer is never asked about again", async () => {
  const seen = serving();
  const view = draw();
  // The pane is on the Bot and reading its computer, as it does while the Bot exists.
  await view.findByText("Expenses’s computer");
  await waitFor(() =>
    expect(seen.expensesBefore.some((path) => path.endsWith("/control"))).toBe(
      true,
    ),
  );

  await pressDelete(view);
  // Through the list coming back without the Bot, and the pane moving to the Bot that is left...
  await waitFor(() => expect(seen.listBackAfterDelete).toBe(true), {
    timeout: LIST_TAKES_MS + 3_000,
  });
  await view.findByText("Sales’s computer");
  // ...and on for two more reads of that Bot's computer, which is read as before.
  await waitFor(
    () =>
      expect(
        seen.salesAfterList.filter((path) => path.endsWith("/control")).length,
      ).toBeGreaterThanOrEqual(2),
    { timeout: 5_000 },
  );

  // The Bot is gone, so asking about its computer could only answer that it is not found.
  expect(seen.expensesAfter).toEqual([]);
}, 15_000);

test("a delete that fails leaves the Bot's computer being read", async () => {
  const seen = serving({ deleteFails: true });
  const view = draw();
  await view.findByText("Expenses’s computer");

  /*
   * The app's own delete, asked for without the button: the button's press hands the refusal on as
   * a rejected promise nothing takes, which a test run counts as its own failure.
   */
  const refusal = await act(() =>
    new MutationObserver(queryClient, deleteAgentMutationOptions(queryClient))
      .mutate(EXPENSES.id)
      .then(
        () => null,
        (error: Error) => error.message,
      ),
  );
  expect(refusal).toBe("This Bot can't be deleted right now.");
  // The Bot is still there, so its computer is read again: who has control, once a second.
  const asked = () =>
    seen.expensesAfter.filter((path) => path.endsWith("/control")).length;
  const whenRefused = asked();
  await waitFor(() => expect(asked()).toBeGreaterThanOrEqual(whenRefused + 2), {
    timeout: 5_000,
  });
  expect(view.getByText("Expenses’s computer")).toBeTruthy();
}, 15_000);
