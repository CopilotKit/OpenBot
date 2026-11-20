import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useDesktopOpenRequests } from "@/lib/desktop/open-requests";
import { settleReactWork } from "./settle-react-work";

/**
 * A click on a notification opens its page in OpenBot Desktop as a route change. MEASURED on
 * Windows: each click loaded the whole page again, losing what the person was in the middle of.
 * The shell runs `notice::open_script` in the page (desktop/src-tauri/src/notice.rs); this is that
 * script, as its test there pins it, run against the page's real router.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010" }));
afterAll(async () => {
  cleanup();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** What `notice::open_script("/channel/c-1", "http://127.0.0.1:3010/channel/c-1")` runs. */
const OPEN_SCRIPT = `(() => { const event = new CustomEvent("openbot:open", { detail: { path: "/channel/c-1" }, cancelable: true }); if (window.dispatchEvent(event)) window.location.assign("http://127.0.0.1:3010/channel/c-1"); })();`;

test("a click on a notice opens its page as a route change, keeping the page and what is in it", async () => {
  const loads: string[] = [];
  const originalAssign = window.location.assign;
  window.location.assign = (url: string | URL) => {
    loads.push(String(url));
  };
  function Page() {
    useDesktopOpenRequests();
    return null;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));

  act(() => {
    new Function(OPEN_SCRIPT)();
  });

  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/c-1"),
  );
  expect(loads).toEqual([]);
  window.location.assign = originalAssign;
});

test("a page that does not handle it is loaded at the notice's page instead", () => {
  const loads: string[] = [];
  const originalAssign = window.location.assign;
  window.location.assign = (url: string | URL) => {
    loads.push(String(url));
  };
  cleanup();

  new Function(OPEN_SCRIPT)();

  expect(loads).toEqual(["http://127.0.0.1:3010/channel/c-1"]);
  window.location.assign = originalAssign;
});

test("only a page of this OpenBot is opened, never another site", async () => {
  function Page() {
    useDesktopOpenRequests();
    return null;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ["/bots"] }),
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));

  for (const path of ["//example.com/x", "https://example.com/", 7]) {
    const event = new CustomEvent("openbot:open", {
      detail: { path },
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(router.state.location.pathname).toBe("/bots");
});
