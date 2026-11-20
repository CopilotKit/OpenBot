import { expect, test } from "bun:test";
import { linkCompanyAccount, RETURN_ADDRESS } from "../mobile/src/link-company";

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
  expect(opened).toEqual([["https://openbot.example/ticket/1", RETURN_ADDRESS]]);

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
