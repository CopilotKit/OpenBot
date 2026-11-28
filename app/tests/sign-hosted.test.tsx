import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloudSignInDeps } from "@/components/auth/cloud-sign-in";
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { GetDeploymentResponse } from "@/lib/api/generated/organization-settings/organization-settings.zod";
import { appConfig } from "@/lib/generated/application-config";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * The signed-out screen on OpenBot Cloud, and on every other OpenBot.
 *
 * OpenBot Cloud is the OpenBot whose people sign in through OpenBot Cloud's own sign-in
 * (`Deployment.hostedSignIn`, api/openapi/admin-settings.yaml). Its screen offers exactly two
 * things: signing in to OpenBot Cloud, as a link to /api/auth/hosted/sign-in that brings the person
 * back where sign-in would have, and OpenBot for Business, with the booking calendar. It never offers
 * to install OpenBot on this computer. Every other OpenBot keeps the sign-in screen it had.
 *
 * The OpenBot is a real HTTP server on this computer answering `deployment` with an answer checked
 * against the schema generated from the spec, and refusing everything else as nobody is signed in.
 * The app is the real sign-in gate and sign-in screen, on the app's query client and transport.
 */

let deployment: Record<string, unknown>;
const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;
const openDefault = cloudSignInDeps.open;

function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (/^\/api\/v2\/organizations\/[^/]+\/deployment$/.test(path))
    return NativeResponse.json(GetDeploymentResponse.parse(deployment));
  // Nobody is signed in.
  return new NativeResponse(
    JSON.stringify({
      status: 401,
      code: "UNAUTHENTICATED",
      detail: "Sign in to OpenBot.",
    }),
    {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    },
  );
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  // The Business dialog's booking calendar keeps its address but never fetches it.
  GlobalRegistrator.register({
    url: `http://127.0.0.1:${openbot.port}/`,
    settings: { navigation: { disableChildFrameNavigation: true } },
  });
});
beforeEach(() => {
  deployment = {
    ...getGetDeploymentResponseMock(),
    // A Cloud whose configuration also names a social sign-in: still not offered on its screen.
    authProviders: ["google"],
    hostedSignIn: true,
    ssoConfigured: false,
    ssoRequired: false,
  };
  queryClient.clear();
  globalThis.fetch = pageFetch();
});
afterEach(async () => {
  cleanup();
  cloudSignInDeps.open = openDefault;
  await settleReactWork();
  queryClient.clear();
  globalThis.fetch = nativeFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
});

/** The app opened at `start`: the real sign-in gate in front of a home, and the sign-in screen. */
function openApp(start: string) {
  const root = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const gate = AuthedRoute.options as unknown as Record<string, unknown>;
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
    ...{ beforeLoad: gate.beforeLoad },
  } as never) as unknown as AnyRoute;
  const home = createRoute({
    getParentRoute: () => authed,
    path: "/",
    component: () => <p>The app</p>,
  } as never) as unknown as AnyRoute;
  const sign = SignRoute.options as unknown as Record<string, unknown>;
  const signIn = createRoute({
    getParentRoute: () => root,
    path: "/sign",
    ...{
      validateSearch: sign.validateSearch,
      beforeLoad: sign.beforeLoad,
      component: sign.component,
    },
  } as never) as unknown as AnyRoute;
  const router = createRouter({
    routeTree: root.addChildren([authed.addChildren([home]), signIn]),
    history: createMemoryHistory({ initialEntries: [start] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const origin = () => `http://127.0.0.1:${openbot.port}`;

const SIGN_IN = "Sign in or create an account";

/** Anything that offers OpenBot on this computer, which OpenBot Cloud's screen never does. */
const SELF_CONTAINED = /self-contained|install|this computer/i;

test("OpenBot Cloud's signed-out screen offers signing in and OpenBot for Business, and nothing to install", async () => {
  const view = openApp("/");

  await view.findByRole("heading", { name: "Sign in to OpenBot Cloud" });
  const signIn = view.getByRole("link", { name: SIGN_IN });
  expect(signIn.getAttribute("href")).toBe(
    `/api/auth/hosted/sign-in?returnTo=${encodeURIComponent(origin())}`,
  );
  const business = view.getByRole("button", { name: /OpenBot for Business/ });
  // Signing in comes first, OpenBot for Business after it.
  expect(
    signIn.compareDocumentPosition(business) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // Exactly those two, and the way to a company's own OpenBot: no social sign-in, no company account.
  expect(view.getAllByRole("link").map((link) => link.textContent)).toEqual([
    SIGN_IN,
  ]);
  expect(
    view.getAllByRole("button").map((button) => button.textContent),
  ).toEqual([
    "OpenBot for Business™Your own cloud or on-prem. Book a demo.",
    "Go to it",
  ]);
  expect(view.queryByText(/Sign-in isn't set up yet/)).toBeNull();
  expect(document.body.textContent).not.toMatch(SELF_CONTAINED);

  // OpenBot for Business opens the app's OpenBot for Business view, with its booking calendar.
  fireEvent.click(business);
  const dialog = await view.findByRole("dialog", {
    name: "OpenBot for Business",
  });
  expect(dialog.textContent).toContain(
    "Deploy in your own VPC on AWS, Azure or GCP, on-prem, or on OpenBot Cloud",
  );
  expect(dialog.textContent).toContain("Book a demo");
  expect(dialog.querySelector('iframe[title="Booking calendar"]')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(SELF_CONTAINED);
});

test("sent to sign in while finishing an app's account, OpenBot Cloud's sign-in brings the person back to finish it", async () => {
  const view = openApp("/sign?flow_id=f%201");
  const signIn = await view.findByRole("link", { name: SIGN_IN });
  const returnTo = new URL(
    signIn.getAttribute("href") as string,
    origin(),
  ).searchParams.get("returnTo");
  expect(returnTo).toBe(`${origin()}/api/plugins/arcade/verify?flow_id=f%201`);
});

test("somebody with OpenBot at work types its address and the browser goes there", async () => {
  const opened: string[] = [];
  cloudSignInDeps.open = (address) => opened.push(address);
  const view = openApp("/");
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Go to it" }));

  // The field it asked for, focused.
  const field = view.getByRole("textbox", {
    name: "Your company's OpenBot address",
  });
  expect(document.activeElement).toBe(field);
  // Said in words anybody can follow, with who to ask.
  const help = document.getElementById(
    field.getAttribute("aria-describedby") as string,
  );
  expect(help?.textContent).toBe(
    "Ask your IT team or whoever set up OpenBot at your company for this address.",
  );
  expect(document.body.textContent).not.toMatch(/\b(instance|URL|backend)\b/i);
  const go = () =>
    user.click(
      view.getByRole("button", { name: "Go to your company's OpenBot" }),
    );

  // Not an address: said, and nowhere to go.
  await user.type(field, "not an address");
  await go();
  expect(view.getByRole("alert").textContent).toBe(
    "Enter your company's OpenBot address, such as openbot.example.com.",
  );
  // OpenBot Cloud's own address: they are already here.
  await user.clear(field);
  await user.type(field, origin());
  await go();
  expect(view.getByRole("alert").textContent).toBe(
    "That's OpenBot Cloud. Sign in above.",
  );
  expect(opened).toEqual([]);

  // No scheme is https, as OpenBot Desktop reads it.
  await user.clear(field);
  await user.type(field, " openbot.acme.example ");
  await go();
  expect(opened).toEqual(["https://openbot.acme.example/"]);
});

test("an OpenBot that isn't OpenBot Cloud keeps its own sign-in screen", async () => {
  for (const hostedSignIn of [false, undefined]) {
    deployment = { ...deployment, hostedSignIn };
    if (hostedSignIn === undefined) delete deployment.hostedSignIn;
    queryClient.clear();
    const view = openApp("/");
    await view.findByRole("heading", {
      name: `Sign in to ${appConfig.brand.productName}`,
    });
    // Its configured ways in, and nothing of OpenBot Cloud's.
    expect(
      view.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Continue with Google"]);
    expect(view.queryAllByRole("link")).toEqual([]);
    expect(view.queryByText(/OpenBot Cloud|OpenBot for Business/)).toBeNull();
    expect(view.queryByText(/Already have OpenBot at work/)).toBeNull();
    cleanup();
  }
});

test("OpenBot Cloud never says its sign-in isn't set up, whatever else is configured", async () => {
  deployment = { ...deployment, authProviders: [] };
  const view = openApp("/");
  await view.findByRole("link", { name: SIGN_IN });
  await waitFor(() =>
    expect(view.queryByText(/Sign-in isn't set up yet/)).toBeNull(),
  );
});
