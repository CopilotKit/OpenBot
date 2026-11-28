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
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import {
  publishPlaygroundMutationOptions,
  saveComponentDraftMutationOptions,
} from "@/lib/components/mutations";
import {
  callComponentFunction,
  decideComponent,
} from "@/lib/components/queries";
import * as gallery from "@/lib/copilot/gallery-registry";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as IndexRoute } from "@/routes/_authed/settings/components-gallery/index";
import {
  COMPONENTS_PATH,
  callComponentPath,
  callResponse,
  checkComponentPath,
  componentBody,
  componentPath,
} from "./components-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The app's component calls at the API's addresses: a list read to its last page, a draft saved as
 * the kind of component it is, a Playground component saved before it is published, and the checks a
 * conversation makes failing closed with a sentence a person can read.
 */

/** The Response a real `fetch` returns, read before happy-dom is registered. */
const NativeResponse = globalThis.Response;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

type Sent = { method: string; path: string; body: unknown };
let sent: Sent[] = [];
let answer: (request: Sent) => Response;
const originalFetch = global.fetch;
beforeEach(() => {
  sent = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      const request = {
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      sent.push(request);
      return answer(request);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const compiled = spyOn(gallery, "galleryComponent").mockReturnValue(undefined);
afterAll(() => compiled.mockRestore());

/** Drive one write through react-query, as a screen's press does. */
async function press(
  build: (client: QueryClient) => unknown,
  variables: unknown,
) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const observer = new MutationObserver(client, build(client) as never);
  await observer.mutate(variables as never);
}

test("the components gallery shows every page of the list", async () => {
  answer = ({ path }) => {
    if (!path.startsWith(COMPONENTS_PATH))
      return NativeResponse.json({}, { status: 404 });
    const page = new URL(path, "http://127.0.0.1").searchParams.get("cursor");
    return NativeResponse.json(
      page === "next"
        ? {
            components: [componentBody({ name: "showTable", title: "Table" })],
            nextCursor: null,
          }
        : {
            components: [
              componentBody({ name: "showBarChart", title: "Bar chart" }),
            ],
            nextCursor: "next",
          },
    );
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const index = createRoute({
    path: "/settings/components-gallery",
    getParentRoute: () => rootRoute,
    component: IndexRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index]),
    history: createMemoryHistory({
      initialEntries: ["/settings/components-gallery"],
    }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Table")).toBeTruthy();
  expect(view.getByText("Bar chart")).toBeTruthy();
  expect(sent.map(({ path }) => path)).toEqual([
    `${COMPONENTS_PATH}?limit=100`,
    `${COMPONENTS_PATH}?limit=100&cursor=next`,
  ]);
});

test("a description saved for a Playground component keeps its title and source", async () => {
  answer = () => NativeResponse.json(componentBody({ name: "x" }));
  const source = {
    html: "<p>card</p>",
    css: "",
    jsFunctions: "",
    argumentSchema: {},
    sampleArguments: { city: "Lisbon" },
  };
  await press(saveComponentDraftMutationOptions, {
    component: {
      name: "custom_weather",
      title: "Weather card",
      draftSource: source,
    },
    description: "Shows the weather.",
  });
  await press(saveComponentDraftMutationOptions, {
    component: { name: "showBarChart", title: "Bar chart", draftSource: null },
    description: "Compare values.",
  });
  expect(sent).toEqual([
    {
      method: "PUT",
      path: `${componentPath("custom_weather")}/draft`,
      body: {
        title: "Weather card",
        description: "Shows the weather.",
        source,
      },
    },
    {
      method: "PUT",
      path: `${componentPath("showBarChart")}/draft`,
      body: { description: "Compare values." },
    },
  ]);
});

test("publishing from Playground saves the draft on screen, then publishes it", async () => {
  answer = () => NativeResponse.json(componentBody({ name: "custom_weather" }));
  await press(publishPlaygroundMutationOptions, {
    slug: "weather",
    title: "Weather card",
    description: "Shows the weather.",
    html: "<p>card</p>",
    css: "",
    jsFunctions: "",
    argumentSchema: {},
    sampleArguments: {},
  });
  expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `PUT ${componentPath("custom_weather")}/draft`,
    `POST ${componentPath("custom_weather")}/publish`,
  ]);
});

test("a check or a read the server refuses fails closed, in words a person can read", async () => {
  answer = ({ path }) =>
    path === checkComponentPath("nobody", "showRecord")
      ? NativeResponse.json(
          { detail: "Couldn't find that Bot.", code: "BOT_NOT_FOUND" },
          { status: 404 },
        )
      : path === callComponentPath("bot", "showActivityReport")
        ? callResponse({
            allowed: false,
            reason: "It can't read the data it needs.",
          })
        : NativeResponse.json(
            { detail: "Couldn't read that data. Try again in a moment." },
            { status: 502 },
          );
  expect(await decideComponent("showRecord", "nobody")).toEqual({
    allowed: false,
    reason:
      "OpenBot couldn't be asked whether that component is allowed, so it wasn't shown.",
  });
  expect(
    await callComponentFunction("showActivityReport", "botActivity", {}, "bot"),
  ).toEqual({ allowed: false, reason: "It can't read the data it needs." });
  expect(
    await callComponentFunction("showTable", "botActivity", {}, "bot"),
  ).toEqual({
    allowed: false,
    reason: "Couldn't read that data. Try again in a moment.",
  });
});
