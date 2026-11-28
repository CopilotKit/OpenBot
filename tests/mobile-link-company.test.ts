import { expect, test } from "bun:test";
import { homeView } from "../mobile/src/home-view";
import {
  backToHome,
  linkCompanyAccount,
  onCompanyLinked,
  openWith,
  RETURN_ADDRESS,
  reportCompanyLinked,
} from "../mobile/src/link-company";

// The phone links the person's company account through a single-use ticket: the system browser has no OpenBot session,
// so signing in through the provider there with POST /api/auth/sign-in/sso linked nothing.

test("a tap asks for a ticket for that provider and opens it at once in the system browser, once", async () => {
  const asked: string[] = [];
  const opened: [string, string][] = [];
  const outcome = await linkCompanyAccount("harbor-okta", {
    ticket: async (providerId) => {
      asked.push(providerId);
      return { url: `https://openbot.example/ticket/${asked.length}` };
    },
    open: async (url, returnTo) => {
      opened.push([url, returnTo]);
    },
  });
  expect(outcome).toBe("opened");
  expect(asked).toEqual(["harbor-okta"]);
  expect(opened).toEqual([
    ["https://openbot.example/ticket/1", RETURN_ADDRESS],
  ]);

  // Another tap is a new ticket, never the last one again.
  await linkCompanyAccount("harbor-okta", {
    ticket: async (providerId) => {
      asked.push(providerId);
      return { url: `https://openbot.example/ticket/${asked.length}` };
    },
    open: async (url, returnTo) => {
      opened.push([url, returnTo]);
    },
  });
  expect(opened.map(([url]) => url)).toEqual([
    "https://openbot.example/ticket/1",
    "https://openbot.example/ticket/2",
  ]);
});

test("the browser's session ends at OpenBot's linked deep link, and that link opening the app reads the company sign-in again, which leaves the held state once met", async () => {
  // The address OpenBot's linked page sends the browser to, exactly, with nothing appended.
  expect(RETURN_ADDRESS).toBe("openbotmobile://company-sign-in/linked");
  const opened: string[] = [];
  await linkCompanyAccount("harbor-okta", {
    ticket: async () => ({ url: "https://openbot.example/ticket/1" }),
    open: async (_url, returnTo) => {
      opened.push(returnTo);
    },
  });
  expect(opened).toEqual(["openbotmobile://company-sign-in/linked"]);

  // Opened outside the session (the linked page's Open OpenBot), its screen says so, and Home reads it again.
  let readAgain = 0;
  const stop = onCompanyLinked(() => {
    readAgain++;
  });
  reportCompanyLinked();
  stop();
  reportCompanyLinked();
  expect(readAgain).toBe(1);
  expect(homeView(true, undefined, { required: true, met: false })).toBe(
    "held-out",
  );
  expect(homeView(true, undefined, { required: true, met: true })).toBe(
    "working",
  );
});

/**
 * A stack as Expo Router's documents its calls (expo-router/build/imperative-api.d.ts): `replace` swaps the top screen,
 * `dismissTo` pops down to the href when the stack holds it and otherwise replaces the top screen with it.
 */
function stack(...screens: string[]) {
  return {
    screens,
    replace(href: string) {
      screens.splice(screens.length - 1, 1, href);
    },
    dismissTo(href: string) {
      const at = screens.lastIndexOf(href);
      if (at === -1) this.replace(href);
      else screens.splice(at + 1);
    },
  };
}

test("back from the linked deep link, Home is the only screen: no second Home and no back arrow", () => {
  // The phone end-to-end run: the linked screen redirected (a replace) to a new Home above the one beneath it.
  const opened = stack("/", "/company-sign-in/linked");
  backToHome(opened);
  expect(opened.screens).toEqual(["/"]);

  // The link started the app: Home takes the linked screen's place.
  const started = stack("/company-sign-in/linked");
  backToHome(started);
  expect(started.screens).toEqual(["/"]);
});

test("the system browser opens in the app's own task, so the Custom Tab goes when the app comes back and Back from Home never lands on the sign-in form", async () => {
  // The phone end-to-end run on a release APK: after the return, Back from Home showed the Custom Tab still holding the
  // company's sign-in form. Opened by default, the tab has a task of its own, which outlives the return.
  const sessions: [string, string, unknown][] = [];
  const open = openWith(async (url, returnTo, options) => {
    sessions.push([url, returnTo, options]);
    return { type: "success", url: returnTo };
  });
  await linkCompanyAccount("harbor-okta", {
    ticket: async () => ({ url: "https://openbot.example/ticket/1" }),
    open,
  });
  expect(sessions).toEqual([
    [
      "https://openbot.example/ticket/1",
      "openbotmobile://company-sign-in/linked",
      { createTask: false },
    ],
  ]);
});

test("a provider that no longer counts is answered as stale, so the providers are read again, and nothing opens", async () => {
  const opened: string[] = [];
  const outcome = await linkCompanyAccount("gone-okta", {
    ticket: async () => {
      throw Object.assign(new Error("Couldn't find that identity provider."), {
        status: 404,
        code: "IDENTITY_PROVIDER_NOT_FOUND",
      });
    },
    open: async (url) => {
      opened.push(url);
    },
  });
  expect(outcome).toBe("stale");
  expect(opened).toEqual([]);
});

test("any other refusal is said in the server's sentence, and nothing opens", async () => {
  const opened: string[] = [];
  const refused = await linkCompanyAccount("harbor-okta", {
    ticket: async () => {
      throw Object.assign(new Error("Sign-in isn't available right now."), {
        status: 503,
        code: "SIGN_IN_UNAVAILABLE",
      });
    },
    open: async (url) => {
      opened.push(url);
    },
  }).catch((error: Error) => error.message);
  expect(refused).toBe("Sign-in isn't available right now.");
  expect(opened).toEqual([]);
});
