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
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  installAppErrorReporting,
  ReportedErrorComponent,
  resetAppErrorReports,
} from "@/lib/error-reporting";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { router as appRouter } from "@/router";
import { settleReactWork } from "./settle-react-work";

/**
 * An error the app did not handle reaches OpenBot's own server, at the API's app-errors address,
 * never a telemetry service: the browser holds no key. The router's error screen sends one report
 * for the error it shows, however often it draws; so do an error the page throws and a promise
 * nobody handled; and before the person's organization is known nothing is sent.
 */

const APP_ERRORS = "/api/v2/organizations/default/app-errors";
const originalFetch = globalThis.fetch;
let reports: {
  url: string;
  body: Record<string, unknown>;
  key: string | null;
  keepalive: boolean | undefined;
}[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  reports = [];
  resetAppErrorReports();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      reports.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        key: new Headers(init?.headers).get("idempotency-key"),
        keepalive: init?.keepalive,
      });
      return new Response(null, { status: 204 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** A screen that throws as it draws, behind the app's own error screen. */
function renderBrokenScreen(message: string) {
  const root = createRootRoute();
  const broken = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => {
      throw new TypeError(message);
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([broken]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultErrorComponent: appRouter.options.defaultErrorComponent,
  });
  return render(<RouterProvider router={router} />);
}

test("the app's error screen is the reporting one", () => {
  expect(appRouter.options.defaultErrorComponent).toBe(ReportedErrorComponent);
});

test("a screen that throws shows the error screen and sends one report, through the server", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    const view = renderBrokenScreen(
      "Cannot read properties of undefined (reading 'title')",
    );
    await waitFor(() =>
      expect(view.getByText("Something went wrong!")).toBeTruthy(),
    );
    await waitFor(() => expect(reports).toHaveLength(1));
    await settleReactWork();
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report?.url).toBe(APP_ERRORS);
    expect(report?.keepalive).toBe(true);
    expect(report?.key).toBeTruthy();
    expect(report?.body).toMatchObject({
      source: "error_boundary",
      type: "TypeError",
      message: "Cannot read properties of undefined (reading 'title')",
      surface: "web",
    });
    expect(String(report?.body.stack)).toContain("TypeError");
  } finally {
    quiet.mockRestore();
  }
});

test("an error the page throws and a promise nobody handled are each reported once", async () => {
  installAppErrorReporting();
  installAppErrorReporting();
  const thrown = new RangeError("the page threw");
  window.dispatchEvent(
    new ErrorEvent("error", { error: thrown, message: thrown.message }),
  );
  window.dispatchEvent(
    new ErrorEvent("error", { error: thrown, message: thrown.message }),
  );
  const rejection = new Event("unhandledrejection") as Event & {
    reason: unknown;
  };
  rejection.reason = new Error("nobody handled this");
  window.dispatchEvent(rejection);
  await waitFor(() => expect(reports).toHaveLength(2));
  expect(reports.map((report) => report.body.source)).toEqual([
    "window_error",
    "unhandled_rejection",
  ]);
  expect(reports.every((report) => report.url === APP_ERRORS)).toBe(true);
});

test("before the person's organization is known, nothing is sent", async () => {
  installAppErrorReporting();
  setCurrentOrganization(undefined);
  window.dispatchEvent(
    new ErrorEvent("error", { error: new Error("while signing in") }),
  );
  await settleReactWork();
  expect(reports).toHaveLength(0);
});
