import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The shim the desktop window injects into OpenBot's pages (`outside_links.rs`).
const SHIM = readFileSync(
  join(import.meta.dir, "../src-tauri/src/outside-links.js"),
  "utf8",
);

type Page = Window & {
  __openbotNavigate?: (to: string) => void;
  __openbotOutsideLinks?: boolean;
  __openbotConnected?: boolean;
};

let navigated: string[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/connections" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  navigated = [];
  const page = window as Page;
  page.__openbotOutsideLinks = false;
  page.__openbotConnected = false;
  page.__openbotNavigate = (to) => navigated.push(to);
  // biome-ignore lint/security/noGlobalEval: the desktop window evaluates this shim in the page's global scope; the test must run it the same way.
  globalThis.eval(SHIM);
});

test("an app's consent claimed in a blank tab is handed over once its address arrives", () => {
  // connect-in-new-tab.ts: a blank tab on the click, pointed at the consent when the server answers.
  const tab = window.open("", "_blank");
  expect(tab).not.toBeNull();
  if (!tab) return;
  tab.opener = null;
  expect(navigated).toEqual([]);
  tab.location.replace("https://backend.composio.dev/api/v3/s/abc123");
  expect(navigated).toEqual(["https://backend.composio.dev/api/v3/s/abc123"]);
  // Still waiting while the person is in their browser; done once they are back.
  expect(tab.closed).toBe(false);
  window.dispatchEvent(new Event("focus"));
  expect(tab.closed).toBe(true);
});

test("a window opened straight at another site is handed over", () => {
  window.open("https://copilotkit.ai/talk", "_blank", "noopener,noreferrer");
  expect(navigated).toEqual(["https://copilotkit.ai/talk"]);
});

test("a link to another site meant for a new tab is handed over, not followed here", () => {
  const link = document.createElement("a");
  link.href = "https://app.hubspot.com/oauth/authorize";
  link.target = "_blank";
  link.textContent = "Open HubSpot's sign-in";
  document.body.append(link);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(navigated).toEqual(["https://app.hubspot.com/oauth/authorize"]);
  link.remove();
});

/*
 * Settings' API keys "Open in browser" while the window shows an OpenBot through the relay
 * (the page's origin here, 127.0.0.1:3010) and that OpenBot's own address is on this computer too
 * (127.0.0.1:20001). The link is Base UI's Button rendering an <a>, and the click lands on its
 * icon. Left to the webview as a new window, nothing opened on Windows; handed over as a
 * navigation, the window's guard opens it in the browser.
 */
test("connected, a link to the OpenBot's own address on this computer is handed over", () => {
  (window as Page).__openbotConnected = true;
  const link = document.createElement("a");
  link.href = "http://127.0.0.1:20001/settings/api-keys";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("role", "button");
  const icon = document.createElement("span");
  link.append(icon, "Open in browser");
  document.body.append(link);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  icon.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(navigated).toEqual(["http://127.0.0.1:20001/settings/api-keys"]);

  // The relay's own pages, the window's own origin, are still left alone.
  const own = document.createElement("a");
  own.href = "http://127.0.0.1:3010/bots";
  own.target = "_blank";
  document.body.append(own);
  const stay = new MouseEvent("click", { bubbles: true, cancelable: true });
  own.dispatchEvent(stay);
  expect(stay.defaultPrevented).toBe(false);
  expect(navigated).toEqual(["http://127.0.0.1:20001/settings/api-keys"]);
  link.remove();
  own.remove();
});

test("on this computer, another address on this computer is still left alone", () => {
  const link = document.createElement("a");
  link.href = "http://127.0.0.1:20001/settings/api-keys";
  link.target = "_blank";
  document.body.append(link);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
  expect(navigated).toEqual([]);
  link.remove();
});

test("OpenBot's own pages are left alone", () => {
  const link = document.createElement("a");
  link.href = "http://127.0.0.1:3010/bots";
  link.target = "_blank";
  document.body.append(link);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
  expect(navigated).toEqual([]);
  link.remove();
});
