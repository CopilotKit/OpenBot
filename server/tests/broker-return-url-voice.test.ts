import { describe, expect, test } from "bun:test";
import {
  BrokerReturnUrlError,
  brokerReturnUrl,
  brokerSentence,
} from "../src/plugins/broker";

/**
 * Which provider a refused return address names, and who its remedy is written for.
 *
 * The sentences used to spell `Composio` as a literal, on a function that took no provider at all
 * — so an Arcade deployment, which is the only kind that reaches the authorize route this refusal
 * guards, told a person a failure involving a vendor it does not use. They also handed that person
 * `OPENBOT_APP_URL`, which is an environment variable nobody but an operator can set.
 *
 * So these pin both halves, exactly as `broker-unconfigured-voice.test.ts` pins them for the
 * unconfigured sentence: what reaches the person names no vendor and no setting (spec D11), and
 * the operator's own sentence names the ACTIVE provider and the variable that fixes it. Neither
 * quotes the address, which is the property the seam test already held and this must not loosen.
 *
 * ARITY IS A RUNTIME ASSERTION, NOT `@ts-expect-error`: `server/tests` is outside `tsc`, so an
 * expect-error written here would assert nothing, and `Function.length` falls the moment the
 * provider is made optional or defaulted back to Composio.
 */

/** Every way a return address can be refused, with the address that provokes it. */
const REFUSALS = [
  { kind: "never built", address: "   " },
  { kind: "not a web address", address: "openbot.example.com/settings/x" },
] as const;

function refusalOf(address: string, provider: "composio" | "arcade") {
  try {
    brokerReturnUrl(address, provider);
  } catch (error) {
    if (error instanceof BrokerReturnUrlError) return error;
    throw error;
  }
  throw new Error(`${address} was not refused`);
}

describe("brokerReturnUrl, as a person reads it", () => {
  for (const { kind, address } of REFUSALS) {
    test(`an address ${kind} names no vendor and no setting`, () => {
      for (const provider of ["composio", "arcade"] as const) {
        const error = refusalOf(address, provider);
        expect(error.message).not.toMatch(/composio|arcade/i);
        expect(error.message).not.toMatch(/OPENBOT_APP_URL|API_KEY/);
        // The route answers with this one, so it is the one that must be safe.
        expect(brokerSentence(error)).toBe(error.message);
      }
    });

    test(`an address ${kind} reads the same on either provider`, () => {
      expect(refusalOf(address, "composio").message).toBe(
        refusalOf(address, "arcade").message,
      );
    });
  }

  test("the two mistakes stay two sentences", () => {
    expect(refusalOf("   ", "arcade").message).not.toBe(
      refusalOf("openbot.example.com/settings/x", "arcade").message,
    );
  });
});

describe("brokerReturnUrl, as an operator reads it", () => {
  test("an Arcade deployment is told Arcade and never Composio", () => {
    for (const { address } of REFUSALS) {
      const { operatorMessage } = refusalOf(address, "arcade");
      expect(operatorMessage).toContain("Arcade");
      expect(operatorMessage).not.toMatch(/composio/i);
    }
  });

  test("a Composio deployment is told Composio and never Arcade", () => {
    for (const { address } of REFUSALS) {
      const { operatorMessage } = refusalOf(address, "composio");
      expect(operatorMessage).toContain("Composio");
      expect(operatorMessage).not.toMatch(/arcade/i);
    }
  });

  test("the remedy is named to the only reader who can apply it", () => {
    for (const { address } of REFUSALS) {
      expect(refusalOf(address, "arcade").operatorMessage).toContain(
        "OPENBOT_APP_URL",
      );
    }
  });

  test("neither sentence quotes the address it refused", () => {
    const address = "openbot-tenant-42.internal.corp/connections/9f3c";
    const error = refusalOf(address, "arcade");

    for (const sentence of [error.message, error.operatorMessage]) {
      expect(sentence).not.toContain(address);
      expect(sentence).not.toContain("openbot-tenant-42.internal.corp");
      expect(sentence).not.toContain("/connections/9f3c");
    }
  });
});

describe("brokerReturnUrl's signature", () => {
  test("cannot be called without a provider", () => {
    expect(brokerReturnUrl.length).toBe(2);
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: the omission is the point
      (brokerReturnUrl as any)("   "),
    ).toThrow();
  });
});
