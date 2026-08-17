import { describe, expect, test } from "bun:test";
import { egressFor, egressLabel, egressVariableFor } from "../src/egress";

/**
 * Per-Bot egress, tested on the paths an operator will actually take.
 *
 * The case that matters most is the last one: a proxy URL usually carries a password, and the label is
 * rendered on an admin page and returned by an API. A test that only checked the happy parse would
 * have been perfectly green while publishing credentials.
 */

describe("naming the variable", () => {
  test("a bot id becomes a usable environment variable name", () => {
    expect(egressVariableFor("sales-bot")).toBe("EGRESS_PROXY_SALES_BOT");
    // A bot id is a free-form string and an environment variable name is not.
    expect(egressVariableFor("Sales Bot #2")).toBe("EGRESS_PROXY_SALES_BOT__2");
  });
});

describe("resolving a Bot's proxy", () => {
  test("no configuration means direct, not a broken proxy", () => {
    expect(egressFor("sales", {})).toBeNull();
    expect(egressLabel("sales", {})).toBeNull();
  });

  test("blank configuration is treated as absent", () => {
    // An operator who sets the variable and leaves it empty means "no proxy". Passing "" to Playwright
    // as a server would fail every request instead.
    expect(egressFor("sales", { EGRESS_PROXY_SALES: "   " })).toBeNull();
  });

  test("the Bot's own variable wins over the default", () => {
    const env = {
      EGRESS_PROXY_DEFAULT: "http://shared.proxy:8080",
      EGRESS_PROXY_SALES: "http://sales.proxy:8080",
    };
    expect(egressFor("sales", env)?.server).toBe("http://sales.proxy:8080");
    // And a Bot without its own falls back, so one variable covers a fleet.
    expect(egressFor("research", env)?.server).toBe("http://shared.proxy:8080");
  });

  test("credentials in the URL are split out, as Playwright wants them", () => {
    const proxy = egressFor("sales", {
      EGRESS_PROXY_SALES: "http://bot:s3cret@proxy.internal:8080",
    });
    expect(proxy).toEqual({
      server: "http://proxy.internal:8080",
      username: "bot",
      password: "s3cret",
    });
  });

  test("percent-encoded credentials are decoded", () => {
    // A password with an @ or a colon in it has to be encoded to fit in a URL, and handing Playwright
    // the still-encoded form authenticates with the wrong password and looks like a proxy fault.
    const proxy = egressFor("sales", {
      EGRESS_PROXY_SALES: "http://bot:p%40ss%3Aword@proxy.internal:8080",
    });
    expect(proxy?.password).toBe("p@ss:word");
  });

  test("a bare host:port is accepted rather than rejected", () => {
    // What an operator writes when they are not thinking about URLs. Playwright accepts it too.
    expect(
      egressFor("sales", { EGRESS_PROXY_SALES: "proxy.internal:8080" }),
    ).toEqual({
      server: "proxy.internal:8080",
    });
  });
});

describe("what gets shown to people", () => {
  test("the label is the host only, never the credentials", () => {
    // The label goes into an admin page and an API response. Returning the
    // server string verbatim would publish the password to anyone who can read either.
    const env = { EGRESS_PROXY_SALES: "http://bot:s3cret@proxy.internal:8080" };
    const label = egressLabel("sales", env);
    expect(label).toBe("proxy.internal:8080");
    expect(label).not.toContain("s3cret");
    expect(label).not.toContain("bot:");
  });

  test("a bare host:port labels as itself", () => {
    expect(
      egressLabel("sales", { EGRESS_PROXY_SALES: "proxy.internal:8080" }),
    ).toBe("proxy.internal:8080");
  });
});
