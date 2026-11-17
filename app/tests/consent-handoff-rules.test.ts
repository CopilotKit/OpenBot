import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  appNameFromKey,
  consentHandoffWords,
  forgetConsentHandoff,
  readConsentHandoff,
  signInPageFor,
  storeConsentHandoff,
} from "@/lib/plugins/consent-handoff";

/**
 * The rules behind OpenBot's step before a sign-in through Composio, on the inputs it really gets.
 *
 * `/connecting` sends the browser wherever the step it finds says. So it must find only what
 * OpenBot's own pages left there: a made-up name finds nothing, and nothing but a web address is
 * ever followed. And the step names whose page comes next only where that is known.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:57230/" }));
afterAll(() => GlobalRegistrator.unregister());

test("a step left by OpenBot is found once, and a name nobody left finds nothing", () => {
  const id = storeConsentHandoff({
    app: "Gmail",
    signIn: "Google",
    url: "https://connect.composio.dev/link/lk_abc",
  });
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(readConsentHandoff(id)).toEqual({
    app: "Gmail",
    signIn: "Google",
    logo: null,
    url: "https://connect.composio.dev/link/lk_abc",
  });
  forgetConsentHandoff(id);
  expect(readConsentHandoff(id)).toBeNull();
  expect(readConsentHandoff("made-up")).toBeNull();
});

test("nothing but a web address is ever followed", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "not a url"]) {
    const id = storeConsentHandoff({ app: "Gmail", signIn: null, url });
    expect(readConsentHandoff(id)).toBeNull();
  }
});

test("the step names Google, Slack or Microsoft only for their own apps, and the app's own page otherwise", () => {
  expect(signInPageFor({ title: "Gmail", slug: "gmail" })).toBe("Google");
  expect(signInPageFor({ title: "Google Calendar", slug: null })).toBe(
    "Google",
  );
  expect(signInPageFor({ title: "Slack", slug: "slack" })).toBe("Slack");
  expect(signInPageFor({ title: "Outlook", slug: "outlook" })).toBe(
    "Microsoft",
  );
  expect(signInPageFor({ title: "Notion", slug: "notion" })).toBeNull();
  expect(
    consentHandoffWords({ app: "Notion", signIn: null }).countdown(5),
  ).toBe("Taking you to Notion's sign-in page in 5");
});

test("the page Desktop comes back to names the app from its key, or says your account", () => {
  expect(appNameFromKey("composio-gmail")).toBe("Gmail");
  expect(appNameFromKey("composio-googlecalendar")).toBe("Google Calendar");
  expect(appNameFromKey("composio-something-new")).toBeNull();
});
