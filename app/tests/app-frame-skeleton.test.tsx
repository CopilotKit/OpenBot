import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppFrameSkeleton } from "@/components/layout/app-frame-skeleton";
import { forgetSignedIn, rememberSignedIn } from "@/lib/auth/was-signed-in";
import { clearSkin, setSkin } from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * The frame drawn while the sign-in checks run, for somebody who was signed in last time. It is
 * drawn at whatever address is being opened, so each test opens the skeleton at one.
 */

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});
beforeEach(() => {
  rememberSignedIn();
});
afterEach(() => {
  cleanup();
  forgetSignedIn();
  clearSkin();
});
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

/** The skeleton as the whole app, at `path`, once the router has settled there. */
async function openAt(path: string) {
  const router = createRouter({
    routeTree: createRootRoute({ component: AppFrameSkeleton }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(<RouterProvider router={router as never} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await settleReactWork();
  return view;
}

const panelOf = (view: { container: HTMLElement }) =>
  view.container.querySelector('[data-slot="section-panel"]');
const stripOf = (view: { container: HTMLElement }) =>
  view.container.querySelector('[data-slot="strip"]');

test("the panel follows the address", async () => {
  const routines = await openAt("/routines");
  expect(stripOf(routines)).not.toBeNull();
  expect(panelOf(routines)).toBeNull();
  cleanup();

  const home = await openAt("/");
  expect(stripOf(home)).not.toBeNull();
  expect(panelOf(home)).not.toBeNull();
  expect(
    home.container.querySelector('[data-slot="sidebar-inset"]'),
  ).not.toBeNull();
});

test("a skin with its own frame gets nothing", async () => {
  setSkin("opendots");
  const view = await openAt("/");
  expect(view.container.innerHTML).toBe("");
});

test("/onboarding gets nothing", async () => {
  const view = await openAt("/onboarding");
  expect(view.container.innerHTML).toBe("");
});

test("a flag that was never set renders nothing", async () => {
  forgetSignedIn();
  const view = await openAt("/");
  expect(view.container.innerHTML).toBe("");
});
