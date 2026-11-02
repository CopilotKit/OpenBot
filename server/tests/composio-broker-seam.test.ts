import { describe, expect, test } from "bun:test";
import {
  BrokerReturnUrlError,
  BrokerUnconfiguredError,
  brokerReturnUrl,
  brokerSentence,
} from "../src/plugins/broker";
import { createComposioClient } from "../src/plugins/composio-adapter";

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
    const error = new BrokerUnconfiguredError("composio", "operator");

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
 * Each refusal is asserted by the half of its sentence that only it says, because they are two
 * different mistakes — an address nobody built, and a configured one that cannot work — and a test
 * that asked only for what both say would pass just as well if the branches collapsed into one.
 *
 * WHICH SENTENCE EACH READER GETS IS PINNED IN `broker-return-url-voice.test.ts` AND NOT HERE. This
 * file is about which addresses are refused; that one is about whose vocabulary the refusal is
 * written in — a person's, naming no vendor and no variable, and an operator's, naming both.
 */
describe("brokerReturnUrl", () => {
  test("refuses an address that was never built", () => {
    expect(() => brokerReturnUrl("", "composio")).toThrow(
      /no address to bring you back to/,
    );
    expect(() => brokerReturnUrl("   ", "composio")).toThrow(
      /no address to bring you back to/,
    );
    expect(() => brokerReturnUrl("", "composio")).toThrow(BrokerReturnUrlError);
  });

  test("refuses an address no browser could come back through", () => {
    for (const unusable of [
      "openbot.example.com/connections/x",
      "localhost:3001/connections/x",
      "/connections/x",
      "javascript:alert(1)",
    ]) {
      expect(() => brokerReturnUrl(unusable, "composio")).toThrow(
        /isn't a web address/,
      );
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
   *
   * THE SETTING IS NO LONGER ASKED OF THIS SENTENCE, because this is the one the ROUTE ANSWERS and
   * the route is `requireUser`: `OPENBOT_APP_URL` is an operator's remedy, and the assertion that
   * an operator is still given it lives on `operatorMessage` in the voice test.
   */
  test("never quotes the address it refused", () => {
    const address = "openbot-tenant-42.internal.corp/connections/9f3c";

    let thrown: unknown;
    try {
      brokerReturnUrl(address, "composio");
    } catch (error) {
      thrown = error;
    }

    const sentence = brokerSentence(thrown);
    expect(sentence).not.toBeNull();
    expect(sentence).not.toContain(address);
    expect(sentence).not.toContain("openbot-tenant-42.internal.corp");
    expect(sentence).not.toContain("/connections/9f3c");
  });

  test("hands back the address a configured deployment built", () => {
    expect(
      brokerReturnUrl("https://openbot.test/connections/x", "composio"),
    ).toBe("https://openbot.test/connections/x");
    expect(
      brokerReturnUrl("http://localhost:3001/admin/plugins/x", "composio"),
    ).toBe("http://localhost:3001/admin/plugins/x");
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
    const intended = "https://openbot.test/connections/x";

    for (const disguised of [
      " https://openbot.test/connections/x",
      "https://openbot.test/connections/x\n",
      "\thttps://openbot.test/connections/x ",
      "https://openbot\n.test/connections/x",
      "https://openbot.test/conn\tections/x",
      "https://openbot.test/connections\r/x",
    ]) {
      expect(brokerReturnUrl(disguised, "composio")).toBe(intended);
    }
  });
});

/**
 * `grantIsLocal` is a DECLARED PROPERTY of the broker, read off the object and never derived from
 * a vendor's name. Composio holds the grant in this deployment, so it declares true — which is the
 * behaviour it always had, made explicit.
 */
describe("grantIsLocal", () => {
  test("Composio declares that its grant is held by this deployment", () => {
    expect(createComposioClient("never-dialled").broker.grantIsLocal).toBe(
      true,
    );
  });

  /**
   * `authorizations` is the same kind of value one field along: a DECLARED capability, read with a
   * presence test — `if (!broker.authorizations)` — and never with a vendor name. Composio runs no
   * correlated, pollable authorization flow, and saying so is not the same as leaving the field
   * out: an omission would make the field optional in practice, which is the failed-open shape
   * `grantIsLocal` exists to close.
   */
  test("Composio declares no correlated authorization flow", () => {
    expect(createComposioClient("never-dialled").broker.authorizations).toBe(
      null,
    );
  });
});

/**
 * `authProviderOf` is the third declared value on this seam, and Composio's answer is a REAL one.
 *
 * A Composio connection is made against an auth config, and an auth config is per toolkit — so the
 * toolkit IS its own auth provider there, and the set of apps sharing a connection with it is
 * consequently always empty. That is the truth about Composio rather than a degradation of it, the
 * same "degenerate is not absent" `grantsFor` already turns on. A throw would be the alternative,
 * and it would force a presence test into every consumer and a provider branch into a disconnect
 * path.
 */
describe("authProviderOf", () => {
  test("Composio answers the toolkit itself, dialling nothing", async () => {
    const { broker } = createComposioClient("never-dialled");

    expect(await broker.authProviderOf("gmail")).toBe("gmail");
    // Case carried through untouched, as every toolkit spelling on this seam is.
    expect(await broker.authProviderOf("GoogleCalendar")).toBe(
      "GoogleCalendar",
    );
  });
});
