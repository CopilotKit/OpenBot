import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "playwright";
import { parseAriaSnapshot } from "../src/aria-snapshot";
import {
  MASKED_VALUE,
  maskSensitiveValues,
  SECRET_ATTRIBUTE,
  sensitiveRefs,
} from "../src/secret-masking";
import { fillSignIn, originOfUrl, parseSignInFill } from "../src/sign-in";

/**
 * The computer's half of the private sign-in, against a real Chromium and a real login page served
 * on 127.0.0.1: the login is typed by this process, only on the origin it was meant for, and neither
 * the snapshot nor the answer ever shows the password back.
 */
const PASSWORD = "hunter2-not-for-the-model";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let origin = "";

const page = (body: string) =>
  new Response(`<!doctype html><html><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  });

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/login")
        return page(`<form method="post" action="/session">
          <label>Email <input name="email" type="email"></label>
          <label>Password <input name="password" type="password"></label>
          <button>Sign in</button></form>`);
      if (url.pathname === "/session" && request.method === "POST") {
        const form = await request.formData();
        return form.get("password") === PASSWORD &&
          form.get("email") === "a@example.test"
          ? Response.redirect(`${origin}/home`, 303)
          : page(`<p>Wrong password</p><form method="post" action="/session">
              <input name="email" type="email"><input name="password" type="password"></form>`);
      }
      if (url.pathname === "/step-one")
        return page(`<form method="get" action="/step-two">
          <input name="username" autocomplete="username"><button>Next</button></form>`);
      if (url.pathname === "/step-two")
        return page(`<form method="post" action="/session">
          <input name="email" type="email" value="${url.searchParams.get("username") ?? ""}">
          <input name="password" type="password"></form>`);
      if (url.pathname === "/home") return page("<h1>Welcome back</h1>");
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function open(path: string): Promise<Page> {
  const tab = await browser.newPage();
  await tab.goto(`${origin}${path}`);
  return tab;
}

describe("parsing what the server sends", () => {
  test("refuses a body without an origin or password, and never quotes a value", () => {
    expect(parseSignInFill({ origin: "nope", password: PASSWORD })).toBe(
      "A sign-in names the website's origin.",
    );
    expect(parseSignInFill({ origin, password: "" })).toBe(
      "A sign-in needs a password.",
    );
    expect(
      parseSignInFill({ origin: `${origin}/login`, password: PASSWORD }),
    ).toEqual({
      origin,
      password: PASSWORD,
    });
    expect(originOfUrl("about:blank")).toBe("");
  });
});

describe("typing a login", () => {
  test("fills and submits a one-step form, and reports only the outcome", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toEqual({
      submitted: true,
      passwordFieldVisible: false,
      url: `${origin}/home`,
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    await tab.close();
  });

  test("a rejected password leaves a password field showing, which is the failure signal", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: "wrong-one",
    });
    expect(result.submitted).toBe(true);
    expect(result.passwordFieldVisible).toBe(true);
    await tab.close();
  });

  test("follows a two-step login on the same origin", async () => {
    const tab = await open("/step-one");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({
      submitted: true,
      passwordFieldVisible: false,
    });
    expect(result.url).toBe(`${origin}/home`);
    await tab.close();
  });

  test("types nothing when the page is on another origin", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin: "https://example.com",
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result.submitted).toBe(false);
    expect(result.error).toContain("not on https://example.com");
    expect(await tab.locator("input[type=password]").inputValue()).toBe("");
    await tab.close();
  });
});

describe("secrets typed into the page are not read back", () => {
  test("the aria snapshot shows a password's value, and the masked snapshot does not", async () => {
    const tab = await browser.newPage();
    await tab.setContent(`<form>
      <input aria-label="User" value="alice">
      <input aria-label="Password" type="password" value="${PASSWORD}">
      <input aria-label="API token" id="token" value="tok_live_abc123">
    </form>`);
    // Mark the token field the way a supplied secret is marked.
    await tab
      .locator("#token")
      .evaluate(
        (element, attribute) => element.setAttribute(attribute, "true"),
        SECRET_ATTRIBUTE,
      );
    const yaml = await tab.ariaSnapshot({ mode: "ai" });
    // The leak this guards against, confirmed rather than assumed.
    expect(yaml).toContain(PASSWORD);
    const { elements } = parseAriaSnapshot(yaml);
    const masked = maskSensitiveValues(
      elements,
      await sensitiveRefs(tab, elements),
    );
    const text = JSON.stringify(masked);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("tok_live_abc123");
    expect(text).toContain("alice");
    expect(
      masked.filter((element) => element.value === MASKED_VALUE),
    ).toHaveLength(2);
    await tab.close();
  });
});
