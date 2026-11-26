/**
 * The script the app puts in the web app's page (src/web/bridge.ts), run here in a page made of fakes: who is
 * signed in, registering the phone for push, taking it off before a sign-out, and the messages it sends back.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bridgeScript,
  DEVICE_PATH,
  holdCall,
  ORGANIZATIONS_PATH,
  type PageMessage,
  PROBE,
  readPageMessage,
  registerCall,
} from "../src/web/bridge";
import { PURCHASE_PATHS } from "../src/web/navigation";

/** A generated client's own source, where the API's addresses are written from its spec. */
const generated = (file: string) =>
  readFileSync(
    join(import.meta.dir, "..", "src", "api", "generated", file),
    "utf8",
  );

const WEB = "https://my.open.bot";
const PHONE = {
  id: "phone-1",
  token: "ExponentPushToken[abc]",
  projectId: "a3eaf66f-8f47-4b70-834e-bbcc2b1a8c69",
  platform: "ios" as const,
};

type Sent = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};
type Answer = { status: number; body?: unknown };

/** A page at `origin`, whose server answers with `answer`. `run` evaluates a script in it, as the web view does. */
function page(origin: string, answer: (sent: Sent) => Answer) {
  const sent: Sent[] = [];
  const messages: PageMessage[] = [];
  const styles: string[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const fetch = async (input: unknown, init?: RequestInit) => {
    const address = new URL(String(input), `${origin}/`);
    const request: Sent = {
      path: address.pathname + address.search,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    sent.push(request);
    const { status, body } = answer(request);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  const window: Record<string, unknown> = {
    fetch,
    ReactNativeWebView: {
      postMessage: (data: string) => {
        const message = readPageMessage(data);
        if (message) messages.push(message);
      },
    },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      listeners[name] ??= [];
      listeners[name].push(listener);
    },
  };
  const document = {
    documentElement: {
      appendChild: (style: { textContent: string }) =>
        styles.push(style.textContent),
    },
    head: null,
    createElement: () => ({ textContent: "" }),
    addEventListener: () => {},
  };
  const run = (script: string) =>
    new Function(
      "window",
      "document",
      "location",
      "crypto",
      "setTimeout",
      script,
    )(
      window,
      document,
      { origin, href: `${origin}/` },
      { randomUUID: () => "key-1" },
      (later: () => void) => queueMicrotask(later),
    );
  /** Let every request the script started be answered. */
  const settle = async () => {
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
  };
  return { window, sent, messages, styles, run, settle };
}

const SIGNED_IN = (sent: Sent): Answer => {
  if (sent.path === "/api/me")
    return { status: 200, body: { user: { id: "person-1" } } };
  if (sent.path === "/api/v2/people/me/organizations")
    return {
      status: 200,
      body: {
        organizations: [
          { id: "org-first", active: false },
          { id: "org/active", active: true },
        ],
        nextCursor: null,
      },
    };
  return { status: 200, body: {} };
};

const script = bridgeScript({ origin: WEB, client: "mobile/1.2.0" });

test("the page says who is signed in when it loads", async () => {
  const web = page(WEB, SIGNED_IN);
  web.run(script);
  await web.settle();
  expect(web.sent[0]).toMatchObject({ path: "/api/me", method: "GET" });
  expect(web.messages).toEqual([
    { type: "session", signedIn: true, person: "person-1" },
  ]);
});

test("the page says nobody is signed in when OpenBot answers 401", async () => {
  const web = page(WEB, () => ({ status: 401 }));
  web.run(script);
  await web.settle();
  expect(web.messages).toEqual([{ type: "session", signedIn: false }]);
});

test("an answer that is neither is no answer: the app keeps what it knew", async () => {
  const web = page(WEB, () => ({ status: 503 }));
  web.run(script);
  await web.settle();
  expect(web.messages).toEqual([]);
});

test("on any other address the script does nothing at all", async () => {
  const web = page("https://accounts.example.com", SIGNED_IN);
  const before = web.window.fetch;
  web.run(script);
  web.run(PROBE);
  web.run(registerCall(PHONE));
  await web.settle();
  expect(web.sent).toEqual([]);
  expect(web.messages).toEqual([]);
  expect(web.window.fetch).toBe(before);
  expect(web.styles).toEqual([]);
});

test("the phone is registered in the organization the person works in", async () => {
  const web = page(WEB, SIGNED_IN);
  web.run(script);
  web.run(registerCall(PHONE));
  await web.settle();
  const put = web.sent.find((one) => one.method === "PUT");
  expect(put?.path).toBe(
    "/api/v2/organizations/org%2Factive/people/me/devices/phone-1",
  );
  expect(JSON.parse(put?.body ?? "{}")).toEqual({
    token: PHONE.token,
    projectId: PHONE.projectId,
    platform: "ios",
  });
  expect(put?.headers).toMatchObject({
    "content-type": "application/json",
    "idempotency-key": "key-1",
    "OpenBot-Client": "mobile/1.2.0",
  });
  expect(web.messages).toContainEqual({
    type: "registered",
    ok: true,
    status: 200,
  });
});

test("a refused registration is said, not hidden", async () => {
  const web = page(WEB, (sent) =>
    sent.method === "PUT" ? { status: 403 } : SIGNED_IN(sent),
  );
  web.run(script);
  web.run(registerCall(PHONE));
  await web.settle();
  expect(web.messages).toContainEqual({
    type: "registered",
    ok: false,
    status: 403,
  });
});

test("the phone is taken off every organization before the sign-out is sent", async () => {
  const web = page(WEB, SIGNED_IN);
  web.run(script);
  web.run(registerCall(PHONE));
  await web.settle();
  web.sent.length = 0;
  await (web.window.fetch as typeof fetch)("/api/auth/sign-out", {
    method: "POST",
  });
  await web.settle();
  const order = web.sent.map((one) => `${one.method} ${one.path}`);
  const signOut = order.indexOf("POST /api/auth/sign-out");
  expect(signOut).toBeGreaterThan(0);
  expect(order.slice(0, signOut)).toEqual([
    "GET /api/v2/people/me/organizations",
    "DELETE /api/v2/organizations/org-first/people/me/devices/phone-1",
    "DELETE /api/v2/organizations/org%2Factive/people/me/devices/phone-1",
  ]);
  expect(web.messages).toContainEqual({ type: "removed", ok: true });
  // And the page is asked again who is signed in, now that the answer changed.
  expect(order.slice(signOut + 1)).toContain("GET /api/me");
});

test("a page loaded after the registration still takes the phone off: the app tells it which phone", async () => {
  const web = page(WEB, SIGNED_IN);
  web.run(script);
  web.run(holdCall(PHONE.id));
  await web.settle();
  web.sent.length = 0;
  await (web.window.fetch as typeof fetch)("/api/auth/sign-out", {
    method: "POST",
  });
  await web.settle();
  expect(
    web.sent.filter((one) => one.method === "DELETE").map((one) => one.path),
  ).toEqual([
    "/api/v2/organizations/org-first/people/me/devices/phone-1",
    "/api/v2/organizations/org%2Factive/people/me/devices/phone-1",
  ]);
});

test("a sign-out is sent even when the phone can't be taken off first", async () => {
  const web = page(WEB, (sent) =>
    sent.path === "/api/v2/people/me/organizations"
      ? { status: 500 }
      : SIGNED_IN(sent),
  );
  web.run(script);
  web.run(holdCall(PHONE.id));
  await web.settle();
  web.sent.length = 0;
  const answer = await (web.window.fetch as typeof fetch)(
    "/api/auth/sign-out",
    { method: "POST" },
  );
  expect(answer.status).toBe(200);
  expect(web.sent.map((one) => `${one.method} ${one.path}`)).toContain(
    "POST /api/auth/sign-out",
  );
});

test("the page's other requests pass through untouched", async () => {
  const web = page(WEB, SIGNED_IN);
  web.run(script);
  await web.settle();
  web.sent.length = 0;
  await (web.window.fetch as typeof fetch)("/api/v2/organizations/o1/bots");
  await web.settle();
  expect(web.sent.map((one) => `${one.method} ${one.path}`)).toEqual([
    "GET /api/v2/organizations/o1/bots",
  ]);
});

test("the links that start a payment are hidden", () => {
  const web = page(WEB, SIGNED_IN);
  web.run(script);
  expect(web.styles).toHaveLength(1);
  for (const path of PURCHASE_PATHS)
    expect(web.styles[0]).toContain(`a[href*="${path}"]`);
  expect(web.styles[0]).toContain("display:none!important");
});

test("the script is put in a page once, however often the web view runs it", async () => {
  const web = page(WEB, SIGNED_IN);
  web.run(script);
  const wrapped = web.window.fetch;
  web.run(script);
  await web.settle();
  expect(web.window.fetch).toBe(wrapped);
  expect(web.sent.filter((one) => one.path === "/api/me")).toHaveLength(1);
});

test("only the page's own three messages are read", () => {
  expect(
    readPageMessage(
      JSON.stringify({ openbot: 1, type: "session", signedIn: true }),
    ),
  ).toEqual({ type: "session", signedIn: true });
  for (const refused of [
    "",
    "not json",
    "null",
    JSON.stringify({ type: "session", signedIn: true }),
    JSON.stringify({ openbot: 1, type: "session", signedIn: "yes" }),
    JSON.stringify({ openbot: 1, type: "navigate", to: "https://x.example" }),
    "x".repeat(2_001),
  ])
    expect(readPageMessage(refused)).toBeNull();
  expect(readPageMessage({ openbot: 1 })).toBeNull();
});

test("the addresses the script asks are the ones the API's generated client asks", () => {
  // The script runs in a page, with no generated client to call. These fail when the API moves an address.
  expect(generated("organizations/organizations.ts")).toContain(
    `\`${ORGANIZATIONS_PATH}\``,
  );
  // How the generated client writes a part of an address that is filled in: a dollar sign, then braces.
  const filled = (name: string) =>
    ["$", "{encodeURIComponent(String(", name, "))}"].join("");
  const device = DEVICE_PATH.replace(
    "{organizationId}",
    filled("organizationId"),
  )
    .replace("/people/me/", `/people/${filled("personId")}/`)
    .replace("{deviceId}", filled("deviceId"));
  expect(generated("devices/devices.ts")).toContain(`\`${device}\``);
});
