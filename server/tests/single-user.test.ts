import { describe, expect, test } from "bun:test";
import { singleUserEnabled } from "../src/auth/dev-actor";

/**
 * Whether this deployment lets every visitor in as one administrator.
 *
 * The most dangerous boolean in the codebase and it had no test. It used to be locked with
 * `NODE_ENV === "production"`, which is exactly the wrong way round: `NODE_ENV` is unset unless
 * somebody sets it, so a container on a VM with a hand-written env file and no identity provider
 * served the whole internet as an administrator, silently, because nothing was wrong from the
 * outside. It now takes an explicit flag and refuses to start without one.
 *
 * The cases below are the four a deployment can actually be in.
 */
describe("running with no sign-in", () => {
  test("a configured provider always wins, whatever else is set", () => {
    // A provider means sign-in, so the flag cannot half-disable it. Asserted with the flag on,
    // because the dangerous reading is "the flag opens a deployment that has a provider".
    expect(singleUserEnabled({ OPENBOT_SINGLE_USER: "true" }, true)).toBe(
      false,
    );
    expect(singleUserEnabled({}, true)).toBe(false);
  });

  test("no provider and the flag set runs open, because somebody said so", () => {
    expect(singleUserEnabled({ OPENBOT_SINGLE_USER: "true" }, false)).toBe(
      true,
    );
  });

  test("the older name for the flag still works, so an existing .env keeps running", () => {
    expect(singleUserEnabled({ OPENBOT_DEV_NO_AUTH: "true" }, false)).toBe(
      true,
    );
  });

  test("no provider and no flag refuses to start", () => {
    // The whole point. Not a warning, not a default: a deployment that would admit everybody as an
    // administrator does not come up, and says what to configure.
    expect(() => singleUserEnabled({}, false)).toThrow(
      /No identity provider is configured/,
    );
  });

  test("NODE_ENV decides nothing, in either direction", () => {
    // The previous lock. A server with NODE_ENV unset was the case it had to catch and the case it
    // let through, so neither value may change the answer now.
    expect(() =>
      singleUserEnabled({ NODE_ENV: "development" }, false),
    ).toThrow();
    expect(() =>
      singleUserEnabled({ NODE_ENV: "production" }, false),
    ).toThrow();
    expect(
      singleUserEnabled(
        { NODE_ENV: "production", OPENBOT_SINGLE_USER: "true" },
        false,
      ),
    ).toBe(true);
  });

  test("a flag set to anything but true is not a yes", () => {
    // Read exactly, so `OPENBOT_SINGLE_USER=false` and a stray `1` both refuse rather than opening.
    for (const value of ["false", "1", "yes", "TRUE", ""]) {
      expect(() =>
        singleUserEnabled({ OPENBOT_SINGLE_USER: value }, false),
      ).toThrow();
    }
  });
});
