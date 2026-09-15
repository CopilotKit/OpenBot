import { describe, expect, test } from "bun:test";
import {
  BrokerReturnUrlError,
  BrokerUnconfiguredError,
  brokerReturnUrl,
  brokerSentence,
} from "../src/plugins/broker";

/**
 * The broker seam's three decisions, asserted with no network and no database.
 *
 * Most of `./broker` is a type, which a type checker settles and a test cannot. What is left to
 * assert is the runtime facts the module exists to fix: what an unconfigured deployment says about
 * itself, what it refuses to say about anything else, and which return addresses it will not begin
 * a consent against.
 *
 * The second of those is the one worth a file. `brokerSentence` is what a caller reaches for when a
 * broker call throws, and the tempting shape — a fallback sentence for anything it does not
 * recognise — would report a missing setting for a vendor outage: an operator told to set
 * `COMPOSIO_API_KEY` when the key is set and Composio's socket hung up. Null is how the function
 * declines to guess, and the caller is left to say something true about the failure it actually has.
 */

describe("brokerSentence", () => {
  test("reports the unconfigured deployment in the error's own words", () => {
    const error = new BrokerUnconfiguredError();

    expect(error.message).toContain("COMPOSIO_API_KEY");
    expect(brokerSentence(error)).toBe(error.message);
  });

  test("declines to explain a failure that is not about configuration", () => {
    expect(brokerSentence(new Error("socket hang up"))).toBeNull();
  });
});

/**
 * The return address, which is the one value on this seam a type cannot settle.
 *
 * `authorize`'s `returnUrl` is documented as required and spelled `string`, and `""`, `"   "` and
 * `openbot.example.com/settings/...` all satisfy that: they reach Composio as a callback nobody
 * returns through, and the person who finds out is the one who has just granted a third party
 * access to their mailbox. The route assembles the address at run time from `OPENBOT_APP_URL`, an
 * unvalidated environment string, so `string` really is the strongest promise it can make and the
 * check belongs here rather than in the type.
 *
 * Each refusal is asserted by the half of its sentence that only it says. Both name
 * `OPENBOT_APP_URL`, because both are fixed there, so a test that asked only for the setting would
 * pass just as well if the two branches collapsed into one — and they are two different mistakes:
 * an address nobody built, and a configured one that cannot work.
 */
describe("brokerReturnUrl", () => {
  test("refuses an address that was never built", () => {
    expect(() => brokerReturnUrl("")).toThrow(/built no address/);
    expect(() => brokerReturnUrl("   ")).toThrow(/built no address/);
    expect(() => brokerReturnUrl("")).toThrow(BrokerReturnUrlError);
  });

  test("refuses an address no browser could come back through", () => {
    for (const unusable of [
      "openbot.example.com/settings/connected-accounts/x",
      "localhost:3001/settings/connected-accounts/x",
      "/settings/connected-accounts/x",
      "javascript:alert(1)",
    ]) {
      expect(() => brokerReturnUrl(unusable)).toThrow(/not a web address/);
    }
  });

  /**
   * THE ADDRESS HANDED IN WAS BUILT ON THE HOST THE REFUSAL QUOTES ON PURPOSE, which left this
   * assertion verifying one segment of it.
   *
   * The sentence names `openbot.example.com` in its own example of the fix — "https://
   * openbot.example.com rather than openbot.example.com" — and the value this test passed was
   * `openbot.example.com/settings/...`. So `not.toContain` could only ever have been answered by
   * the path: a refusal that echoed the host back would have matched the message's own example and
   * looked, to this test, exactly like one that had not.
   *
   * The host is the half that carries the most. `OPENBOT_APP_URL` is an environment string and an
   * environment string carries whatever was put in it: a customer's name in a tenant subdomain, an
   * internal hostname that says how this deployment is reached, a preview host with a token in it.
   * This refusal goes to whoever asked — it is a `BrokerRefusalError`, which is a promise
   * that the message is safe to show them — so the address must be absent from it as a whole and
   * in its parts, and the value asked about has to be one no sentence here mentions for its own
   * reasons.
   */
  test("says which setting fixes it, and never quotes the address", () => {
    const address =
      "openbot-tenant-42.internal.corp/settings/connected-accounts/9f3c";

    let thrown: unknown;
    try {
      brokerReturnUrl(address);
    } catch (error) {
      thrown = error;
    }

    const sentence = brokerSentence(thrown);
    expect(sentence).toContain("OPENBOT_APP_URL");
    expect(sentence).not.toContain(address);
    expect(sentence).not.toContain("openbot-tenant-42.internal.corp");
    expect(sentence).not.toContain("/settings/connected-accounts/9f3c");
  });

  test("hands back the address a configured deployment built", () => {
    expect(
      brokerReturnUrl("https://openbot.test/settings/connected-accounts/x"),
    ).toBe("https://openbot.test/settings/connected-accounts/x");
    expect(brokerReturnUrl("http://localhost:3001/admin/plugins/x")).toBe(
      "http://localhost:3001/admin/plugins/x",
    );
  });

  /**
   * The address handed back is the one that was checked, which is the whole of what the check is
   * worth.
   *
   * A guard that reads one value and returns another has approved nothing. `OPENBOT_APP_URL` is an
   * environment string, and an environment string carries whatever was pasted into it: a leading
   * space from a copied address, a trailing newline from a file read line by line, a tab or a
   * carriage return from a variable assembled by a shell. Every one of those is invisible where it
   * is set and every one reaches Composio as part of the callback if the guard hands the raw string
   * back — which is the same person on the same hosted page the guard exists to keep them off.
   *
   * Each case below is the same intended address wearing a different disguise, and the disguises are
   * split deliberately: the first three sit at the ends, where trimming would find them, and the
   * last three sit in the middle of the host and the path, where it would not. A fix that only
   * trimmed would pass the first half of this table and strand somebody on the second.
   */
  test("hands back the address it checked rather than the padding around it", () => {
    const intended = "https://openbot.test/settings/connected-accounts/x";

    for (const disguised of [
      " https://openbot.test/settings/connected-accounts/x",
      "https://openbot.test/settings/connected-accounts/x\n",
      "\thttps://openbot.test/settings/connected-accounts/x ",
      "https://openbot\n.test/settings/connected-accounts/x",
      "https://openbot.test/settings/\tconnected-accounts/x",
      "https://openbot.test/settings\r/connected-accounts/x",
    ]) {
      expect(brokerReturnUrl(disguised)).toBe(intended);
    }
  });
});
