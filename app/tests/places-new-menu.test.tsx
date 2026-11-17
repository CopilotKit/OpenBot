import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as NewBotSheetModule from "@/components/agents/new-bot-sheet";
import { NewMenu } from "@/components/places/new-menu";
import { NewBotCreationStub } from "./channel-new-error-state.fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * THE "+" MENU: FIVE WAYS TO START SOMETHING, EACH WITH ITS OWN TARGET.
 *
 * The router and the menu are real. Only the New Bot sheet is stubbed, a button that finishes
 * creating a Bot, because the sheet is a separate flow with its own tests.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));

const realNewBotSheet = NewBotSheetModule.NewBotSheet;
let restoreSheet = () => {};

beforeEach(() => {
  const spy = spyOn(NewBotSheetModule, "NewBotSheet").mockImplementation(
    ({ open, onClose, onCreated }) =>
      NewBotCreationStub({ open, onClose, onCreated: () => onCreated("b9") }),
  );
  restoreSheet = () => spy.mockRestore();
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    restoreSheet();
    expect(NewBotSheetModule.NewBotSheet).toBe(realNewBotSheet);
  }
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function menuAt() {
  const rootRoute = createRootRoute({ component: Outlet });
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <NewMenu trigger={<button type="button" />} />,
  });
  const plain = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <p>{path}</p>,
    });
  const routine = createRoute({
    getParentRoute: () => rootRoute,
    path: "/routines/new",
    validateSearch: (search: Record<string, unknown>) => ({
      agentId: typeof search.agentId === "string" ? search.agentId : undefined,
    }),
    component: () => <p>/routines/new</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      index,
      plain("/channel/new"),
      plain("/bots/$agentId"),
      routine,
      plain("/browser"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

/** Queries over the whole page, since the menu and the sheet are drawn in portals. */
const page = () => within(document.body);

async function openMenu() {
  const user = userEvent.setup({ document });
  await user.click(await page().findByRole("button", { name: "New" }));
  return user;
}

test("the five entries are in order with their targets", async () => {
  menuAt();
  await openMenu();

  const items = await page().findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "New conversation",
    "New Bot",
    "New routine",
    "New routine for a new Bot",
    "Record a task",
  ]);
  expect(items[0]?.getAttribute("href")).toBe("/channel/new");
  expect(items[2]?.getAttribute("href")).toBe("/routines/new");
  expect(items[4]?.getAttribute("href")).toBe("/browser");
});

test("a Bot made for a routine lands on New routine with it chosen", async () => {
  const router = menuAt();
  const user = await openMenu();

  await user.click(
    await page().findByRole("menuitem", { name: "New routine for a new Bot" }),
  );
  await user.click(
    await page().findByRole("button", { name: "Finish creation" }),
  );

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/routines/new"),
  );
  expect(router.state.location.search).toEqual({ agentId: "b9" });
});

test("a new Bot opens its page", async () => {
  const router = menuAt();
  const user = await openMenu();

  await user.click(await page().findByRole("menuitem", { name: "New Bot" }));
  await user.click(
    await page().findByRole("button", { name: "Finish creation" }),
  );

  await waitFor(() => expect(router.state.location.pathname).toBe("/bots/b9"));
});
