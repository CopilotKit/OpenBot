/**
 * Inside an OpenBot Desktop connected to an OpenBot that runs somewhere else, the desktop app signs
 * every request in, and a sign-in of that kind carries no memory of which organization the person
 * is working in. So the desktop app is told on every switch, after the server has agreed to it and
 * before the app changes over, and it names that organization on each request from then on.
 *
 * In a browser, and with OpenBot on this computer, nobody is told: the session remembers.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { workIn } from "@/lib/organizations/queries";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

/** What happened, in order: each request to the server and each command asked of the desktop app. */
let happened: string[] = [];
let serverAgrees = true;
const originalFetch = globalThis.fetch;

function installShell(answer: "accepts" | "refuses") {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      happened.push(`shell ${command} ${JSON.stringify(args ?? {})}`);
      if (answer === "refuses") throw "command set_organization not found";
      return null;
    },
  };
}

beforeEach(() => {
  happened = [];
  serverAgrees = true;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      happened.push(`server ${new URL(url, "http://127.0.0.1:3010").pathname}`);
      return serverAgrees
        ? Response.json({ id: "org_harbor" })
        : Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test("a switch is told to the desktop app once the server has agreed to it", async () => {
  installShell("accepts");
  await workIn("org_harbor");
  expect(happened).toEqual([
    "server /api/auth/organization/set-active",
    'shell plugin:openbot-desktop|set_organization {"organizationId":"org_harbor"}',
  ]);
});

test("a switch the server refuses is not told to the desktop app", async () => {
  installShell("accepts");
  serverAgrees = false;
  await expect(workIn("org_northwind")).rejects.toThrow();
  expect(happened).toEqual(["server /api/auth/organization/set-active"]);
});

test("a desktop app that has no such command does not stop the switch", async () => {
  installShell("refuses");
  await workIn("org_harbor");
  expect(happened).toHaveLength(2);
});

test("in a browser nobody else is told", async () => {
  await workIn("org_harbor");
  expect(happened).toEqual(["server /api/auth/organization/set-active"]);
});
