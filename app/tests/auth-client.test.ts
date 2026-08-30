import { describe, expect, test } from "bun:test";
import { providerName, signInWith } from "@/lib/auth/client";

/*
 * A browser origin, which the sign-in call needs for its callback URL and this environment has no
 * window to supply. Stubbed rather than designed around: where the browser sends somebody back to
 * is the browser's own business, and threading it through as an argument would only move the same
 * value to the caller.
 */
/*
 * Only when there is not a window already, which there now sometimes is.
 *
 * Assigning unconditionally used to be harmless because nothing in this suite installed a DOM. The
 * rendered tests do, and this stub has a `location` and nothing else — no `history`, no `document`
 * behind it — so overwriting a registered window left `document` defined and `window.history`
 * undefined. `app/src/router.tsx` builds its history at module scope from exactly that pair, and
 * threw while being imported by whichever file reached it next.
 */
(globalThis as { window?: unknown }).window ??= {
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

describe("providerName", () => {
  test("gives each provider the name people call it", () => {
    expect(providerName("google")).toBe("Google");
    expect(providerName("microsoft")).toBe("Microsoft");
    expect(providerName("okta")).toBe("Okta");
  });
});
