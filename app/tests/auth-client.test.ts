import { describe, expect, test } from "bun:test";
import {
  providerName,
  signInWith,
  signInWithEmailDomain,
} from "@/lib/auth/client";

/*
 * A browser origin, which the sign-in call needs for its callback URL and this environment has no
 * window to supply. Stubbed rather than designed around: where the browser sends somebody back to
 * is the browser's own business, and threading it through as an argument would only move the same
 * value to the caller.
 */
(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost:3010" },
};

/**
 * Starting sign-in, for each provider a deployment can configure.
 *
 * The point of these is that all three go the same way. Okta is served by the generic OAuth plugin
 * rather than as a named provider, and it would have been easy to give it its own call; it does not
 * have one because the browser should not know which kind of provider it is asking for, so that a
 * deployment can gain one without the app being rebuilt.
 */
describe("signInWith", () => {
  test.each(["google", "microsoft", "okta"] as const)(
    "starts %s through the same call",
    async (provider) => {
      const asked: string[] = [];

      await signInWith(provider, async (input) => {
        asked.push(input.provider);
        return {};
      });

      expect(asked).toEqual([provider]);
    },
  );

  test("sends the browser back where it started", async () => {
    let callbackURL = "";

    await signInWith("google", async (input) => {
      callbackURL = input.callbackURL;
      return {};
    });

    expect(callbackURL).toBe("http://localhost:3010");
  });

  /**
   * A callbackURL that was asked for is the one that gets used.
   *
   * THE DEFAULT ABOVE IS NOT THE PROPERTY. Pinning only the no-argument case leaves the whole
   * resume mechanism untested: a body that builds `window.location.origin` for itself and never
   * reads its third parameter passes "sends the browser back where it started" exactly as this
   * one does, and the brokered flow somebody was signing back in to resume ends at the home
   * screen with the verifier never asked for. The URL asserted here is the shape
   * `resumeUrlFor` produces, since that is the only caller that passes one.
   */
  test("carries the callbackURL it was given, not the origin", async () => {
    const resume = "http://localhost:3010/api/plugins/arcade/verify?flow_id=h1";
    let asked = "";

    await signInWith(
      "google",
      async (input) => {
        asked = input.callbackURL;
        return {};
      },
      resume,
    );

    expect(asked).toBe(resume);
  });

  test("throws what the client said when it refuses", async () => {
    const refuse = async () => ({
      error: { message: "That provider is not configured." },
    });

    expect(signInWith("okta", refuse)).rejects.toThrow(
      "That provider is not configured.",
    );
  });

  /**
   * A refusal with nothing to say still has to name the provider.
   *
   * With one button this did not matter. With three, "Could not start sign-in" leaves somebody
   * looking at three buttons with no idea which one failed.
   */
  test("names the provider when the client says nothing", async () => {
    const refuse = async () => ({ error: {} });

    expect(signInWith("microsoft", refuse)).rejects.toThrow("Microsoft");
  });

  test("resolves quietly when the redirect is under way", async () => {
    expect(
      signInWith("google", async () => ({ error: null })),
    ).resolves.toBeUndefined();
  });
});

/**
 * Starting sign-in through whichever identity provider covers an address.
 *
 * The SSO leg had no test of its own, and the screen test that drives it replaces this module, so
 * everything below was unpinned: the address could have been dropped, the callbackURL discarded,
 * the refusal swallowed. It is the same call as `signInWith` with a different first argument, and
 * it carries the resume URL for the same reason — somebody whose session lapsed mid-authorization
 * signs back in through their company's IdP and has to land on the verifier, not on the home
 * screen.
 */
describe("signInWithEmailDomain", () => {
  test("hands the address to the starter", async () => {
    let asked = "";

    await signInWithEmailDomain("someone@company.com", async (input) => {
      asked = input.email;
      return {};
    });

    expect(asked).toBe("someone@company.com");
  });

  test("sends the browser back where it started", async () => {
    let callbackURL = "";

    await signInWithEmailDomain("someone@company.com", async (input) => {
      callbackURL = input.callbackURL;
      return {};
    });

    expect(callbackURL).toBe("http://localhost:3010");
  });

  /** The resume half, for the reason given over the same test for `signInWith`. */
  test("carries the callbackURL it was given, not the origin", async () => {
    const resume = "http://localhost:3010/api/plugins/arcade/verify?flow_id=h1";
    let asked = "";

    await signInWithEmailDomain(
      "someone@company.com",
      async (input) => {
        asked = input.callbackURL;
        return {};
      },
      resume,
    );

    expect(asked).toBe(resume);
  });

  test("throws what the client said when it refuses", async () => {
    const refuse = async () => ({
      error: { message: "That domain is registered to another tenant." },
    });

    expect(
      signInWithEmailDomain("someone@company.com", refuse),
    ).rejects.toThrow("That domain is registered to another tenant.");
  });

  test("says no provider is registered when the client says nothing", async () => {
    const refuse = async () => ({ error: {} });

    expect(
      signInWithEmailDomain("someone@company.com", refuse),
    ).rejects.toThrow("No identity provider is registered for that address.");
  });

  test("resolves quietly when the redirect is under way", async () => {
    expect(
      signInWithEmailDomain("someone@company.com", async () => ({
        error: null,
      })),
    ).resolves.toBeUndefined();
  });
});

describe("providerName", () => {
  test("gives each provider the name people call it", () => {
    expect(providerName("google")).toBe("Google");
    expect(providerName("microsoft")).toBe("Microsoft");
    expect(providerName("okta")).toBe("Okta");
  });
});
