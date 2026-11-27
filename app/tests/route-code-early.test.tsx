import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createLazyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { loadCodeEarly } from "@/lib/route-code";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1/" });
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/** A root, a gate whose `beforeLoad` waits for `release`, and a leaf at `/page` whose code comes from `lazyFn`. */
function build(lazyFn: () => Promise<unknown>, gate: Promise<void>) {
  const root = createRootRoute({ component: Outlet });
  const gateRoute = createRoute({
    getParentRoute: () => root,
    id: "gate",
    beforeLoad: () => gate,
    component: Outlet,
  });
  const leaf = createRoute({
    getParentRoute: () => gateRoute,
    path: "/page",
  }).lazy(lazyFn as never);
  return createRouter({
    routeTree: root.addChildren([gateRoute.addChildren([leaf])]),
    history: createMemoryHistory({ initialEntries: ["/page"] }),
    defaultPendingMs: 0,
  });
}

const page = () =>
  createLazyRoute("/page" as never)({ component: () => <p>The page</p> });

test("a page's code starts loading before its parent's beforeLoad finishes", async () => {
  let started = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = build(() => {
    started = true;
    return Promise.resolve(page());
  }, gate);
  const stop = loadCodeEarly(router);
  const loading = router.load();
  expect(started).toBe(true);
  release();
  await loading;
  const view = render(<RouterProvider router={router} />);
  expect(await view.findByText("The page")).toBeTruthy();
  stop();
});

test("a chunk that fails to load early is not an error", async () => {
  let attempts = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const router = build(() => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error("offline"))
      : Promise.resolve(page());
  }, Promise.resolve());
  const stop = loadCodeEarly(router);
  try {
    await router.load();
    const view = render(<RouterProvider router={router} />);
    expect(await view.findByText("The page")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(2);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    stop();
  }
});

test("a chunk still failing when the router asks fails the page as the router's own error, with nothing unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = build(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    throw new Error("offline");
  }, gate);
  const stop = loadCodeEarly(router);
  try {
    const loading = router.load();
    release();
    await loading;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(router.state.matches.at(-1)?.status).toBe("error");
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    stop();
  }
});
