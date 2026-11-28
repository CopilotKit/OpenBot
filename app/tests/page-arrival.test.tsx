import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { PageArrival } from "@/components/layout/page-arrival";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import { Route as NewChannelRoute } from "@/routes/_authed/_app/channel/new";
import { Route as GroupRoute } from "@/routes/_authed/_app/group/$channelId";
import { Route as StartRoute } from "@/routes/_authed/_app/start.$startId";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
afterEach(() => cleanup());
afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

function openApp(start: string) {
  const root = createRootRoute({
    component: () => (
      <PageArrival>
        <Outlet />
      </PageArrival>
    ),
  });
  const page = (path: string, text: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p>{text}</p>,
    });
  const shared = (path: string, text: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      staticData: { arrival: "conversation" },
      component: () => <p>{text}</p>,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/a", "page a"),
      page("/b", "page b"),
      page("/c/$id", "page c"),
      shared("/d", "page d"),
      shared("/e", "page e"),
    ]),
    history: createMemoryHistory({ initialEntries: [start] }),
  });
  const view = render(<RouterProvider router={router as never} />);
  return { view, router };
}

test("a new page arrives in a fresh wrapper", async () => {
  const { view, router } = openApp("/a");
  await view.findByText("page a");
  const before = view.container.querySelector(".page-arrival");
  await router.navigate({ to: "/b" } as never);
  await view.findByText("page b");
  const after = view.container.querySelector(".page-arrival");
  expect(before).not.toBeNull();
  expect(after).not.toBe(before);
});

test("the same page with other params keeps its wrapper", async () => {
  const { view, router } = openApp("/c/1");
  await view.findByText("page c");
  const before = view.container.querySelector(".page-arrival");
  expect(before).not.toBeNull();
  await router.navigate({ to: "/c/$id", params: { id: "2" } } as never);
  await waitFor(() => expect(router.state.location.pathname).toBe("/c/2"));
  expect(view.container.querySelector(".page-arrival")).toBe(before);
});

test("pages that hand over to each other keep their wrapper", async () => {
  const { view, router } = openApp("/d");
  await view.findByText("page d");
  const before = view.container.querySelector(".page-arrival");
  expect(before).not.toBeNull();
  await router.navigate({ to: "/e" } as never);
  await view.findByText("page e");
  expect(view.container.querySelector(".page-arrival")).toBe(before);
});

/** The text between the braces that open at `open`, with nested blocks kept. */
function blockAt(css: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}" && --depth === 0)
      return { body: css.slice(open + 1, i), end: i + 1 };
  }
  throw new Error("Unbalanced braces in styles.css.");
}

test("no motion when less is asked for", () => {
  const css = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const media =
    /@media\s*\(\s*prefers-reduced-motion:\s*no-preference\s*\)\s*\{/g;
  let outside = css;
  const inside: string[] = [];
  for (const found of [...css.matchAll(media)].reverse()) {
    const open = found.index + found[0].length - 1;
    const { body, end } = blockAt(css, open);
    inside.push(body);
    outside = outside.replace(css.slice(found.index, end), "");
  }
  expect(
    inside.filter((b) => /\.page-arrival\s*\{[^}]*animation:/.test(b)),
  ).toHaveLength(1);
  expect(outside).not.toMatch(/\.page-arrival[^{]*\{[^}]*animation/);
});

test("the conversation routes all hand over to each other", () => {
  const routes = [StartRoute, NewChannelRoute, ChannelRoute, GroupRoute];
  for (const route of routes)
    expect(
      (route.options as { staticData?: { arrival?: string } }).staticData
        ?.arrival,
    ).toBe("conversation");
});
