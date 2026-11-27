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
  const router = createRouter({
    routeTree: root.addChildren([
      page("/a", "page a"),
      page("/b", "page b"),
      page("/c/$id", "page c"),
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
  await router.navigate({ to: "/c/$id", params: { id: "2" } } as never);
  await waitFor(() => expect(router.state.location.pathname).toBe("/c/2"));
  expect(view.container.querySelector(".page-arrival")).toBe(before);
});

test("no motion when less is asked for", () => {
  const css = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const block = css.match(
    /@media \(prefers-reduced-motion: no-preference\) \{\s*\.page-arrival \{[^}]*animation:[^}]*\}\s*\}/,
  );
  expect(block).not.toBeNull();
  expect(css.match(/\.page-arrival \{[^}]*animation/g)?.length).toBe(1);
});
