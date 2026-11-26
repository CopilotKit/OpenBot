/**
 * The web view's address, where it may go, and where a notification takes it (src/web/address.ts,
 * src/web/navigation.ts).
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readWebAddress } from "../src/web/address";
import {
  APPROVALS_PAGE,
  CONVERSATION_ROUTE,
  navigationVerdict,
  PURCHASE_PATHS,
  webDestination,
} from "../src/web/navigation";

const WEB = "https://my.open.bot";

test("no address named means no web view, and the app draws its own screens", () => {
  expect(readWebAddress(undefined, false)).toBeNull();
  expect(readWebAddress("", false)).toBeNull();
  expect(readWebAddress("   ", false)).toBeNull();
});

test("the address is the web app's origin, and nothing else is taken", () => {
  expect(readWebAddress("https://my.open.bot", false)).toBe(WEB);
  expect(readWebAddress(" https://my.open.bot/ ", false)).toBe(WEB);
  for (const refused of [
    "my.open.bot",
    "http://my.open.bot",
    "https://user:secret@my.open.bot",
    "https://my.open.bot/sign",
    "https://my.open.bot/?next=1",
    "https://my.open.bot/#top",
  ])
    expect(() => readWebAddress(refused, false)).toThrow();
});

test("a development build may use a web app on plain http", () => {
  expect(readWebAddress("http://localhost:5173", true)).toBe(
    "http://localhost:5173",
  );
});

test("a web address loads where it was asked for, the sign-in's pages included", () => {
  for (const loaded of [
    `${WEB}/`,
    `${WEB}/channel/abc`,
    `${WEB}/api/auth/hosted/sign-in?returnTo=%2F`,
    `${WEB}/api/auth/hosted/sign-out?returnTo=%2Fsign`,
    "https://accounts.example.com/sign-in",
    "about:blank",
    "about:srcdoc",
    "blob:https://my.open.bot/1b2c",
  ])
    expect(navigationVerdict(loaded, WEB)).toBe("load");
});

test("a page that pays for a plan is never opened", () => {
  for (const path of PURCHASE_PATHS)
    expect(navigationVerdict(`${WEB}${path}?organizationId=o1`, WEB)).toBe(
      "purchase",
    );
  for (const paying of [
    "https://cloud.example.com/openbot/checkout?handoff=1",
    "https://cloud.example.com/openbot/seats",
    "https://checkout.stripe.com/c/pay/cs_live_1",
    "https://buy.stripe.com/abc",
  ])
    expect(navigationVerdict(paying, WEB)).toBe("purchase");
  // Only those addresses. A page that only has the word in it is a page like any other.
  expect(navigationVerdict(`${WEB}/settings/checkout-notes`, WEB)).toBe("load");
});

test("an address for another app is the phone's to open, and a script or the app's own link is nobody's", () => {
  expect(navigationVerdict("mailto:help@example.com", WEB)).toBe("outside");
  expect(navigationVerdict("tel:+15550100", WEB)).toBe("outside");
  expect(navigationVerdict("itms-apps://apps.apple.com/app/id1", WEB)).toBe(
    "outside",
  );
  expect(navigationVerdict("javascript:alert(1)", WEB)).toBe("blocked");
  expect(
    navigationVerdict("openbotmobile://conversation?channelId=c1", WEB),
  ).toBe("blocked");
  expect(navigationVerdict("not an address", WEB)).toBe("blocked");
});

test("a notification opens the conversation it is about, or the approvals inbox", () => {
  expect(
    webDestination(WEB, {
      url: "openbotmobile://conversation?channelId=c%2F1",
    }),
  ).toBe(`${WEB}/channel/c%2F1`);
  expect(
    webDestination(WEB, {
      url: "openbotmobile://approvals?channelId=c1&requestId=r1",
    }),
  ).toBe(`${WEB}/settings/approvals`);
  expect(webDestination(WEB, { url: "openbotmobile://needs-you" })).toBe(
    `${WEB}/settings/approvals`,
  );
});

test("a notification that names no known screen opens nothing", () => {
  expect(webDestination(WEB, null)).toBeNull();
  expect(webDestination(WEB, {})).toBeNull();
  expect(webDestination(WEB, { url: "https://evil.example/" })).toBeNull();
  expect(
    webDestination(WEB, { url: "openbotmobile://conversation" }),
  ).toBeNull();
  expect(
    webDestination(WEB, { url: "openbotmobile://elsewhere?channelId=c1" }),
  ).toBeNull();
});

test("the pages a notification opens are routes the web app has", () => {
  // The app only knows these two by name. A route the web app renames or removes fails here, not on a phone.
  const routes = readFileSync(
    join(import.meta.dir, "..", "..", "app", "src", "routeTree.gen.ts"),
    "utf8",
  );
  expect(routes).toContain(`'${CONVERSATION_ROUTE}'`);
  expect(routes).toContain(`'${APPROVALS_PAGE}'`);
});
