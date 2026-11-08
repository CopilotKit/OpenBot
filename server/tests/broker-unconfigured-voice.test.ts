import { describe, expect, test } from "bun:test";
import { BrokerUnconfiguredError } from "../src/plugins/broker";

/**
 * Which provider an "unconfigured broker" sentence names, and who it is written for.
 *
 * The constructor used to DEFAULT to Composio, so a call site that passed nothing put
 * `COMPOSIO_API_KEY` on an Arcade deployment's screen. The parameter is required now and these pin
 * both halves: the operator's sentence names the ACTIVE provider's variable, and a person's names
 * no vendor and no variable at all (spec D11) because they can set neither.
 *
 * NO-ARGUMENT PIN IS A RUNTIME ASSERTION, NOT `@ts-expect-error`: `server/tests` is outside `tsc`,
 * so an expect-error written here would assert nothing. `Function.length` counts the parameters
 * before the first default, so it falls the moment a default is reintroduced; the second assertion
 * is the behaviour that makes an omission loud rather than a Composio sentence.
 */
const COMPOSIO_OPERATOR =
  "Connecting apps isn't set up on this deployment, so nothing was asked. Set COMPOSIO_API_KEY to make these apps available. Until it is set there is nothing to connect, nothing to grant and no tool from these apps for a Bot to call.";

describe("BrokerUnconfiguredError", () => {
  test("a Composio operator is told the variable, and never the vendor", () => {
    expect(new BrokerUnconfiguredError("composio", "operator").message).toBe(
      COMPOSIO_OPERATOR,
    );
  });

  test("an Arcade operator is told Arcade's variable and never Composio's", () => {
    const message = new BrokerUnconfiguredError("arcade", "operator").message;
    expect(message).not.toMatch(/\bArcade\b/);
    expect(message).toContain("ARCADE_API_KEY");
    expect(message).not.toMatch(/composio/i);
    expect(message).not.toContain("COMPOSIO_API_KEY");
  });

  test("a person is told no vendor and no variable, on either provider", () => {
    for (const provider of ["composio", "arcade"] as const) {
      const message = new BrokerUnconfiguredError(provider, "person").message;
      expect(message).not.toMatch(/composio|arcade/i);
      expect(message).not.toMatch(/API_KEY/);
    }
    expect(new BrokerUnconfiguredError("composio", "person").message).toBe(
      new BrokerUnconfiguredError("arcade", "person").message,
    );
  });

  test("the constructor cannot be called with nothing", () => {
    expect(BrokerUnconfiguredError.length).toBe(2);
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: the omission is the point
      () => new (BrokerUnconfiguredError as any)(),
    ).toThrow();
  });
});
