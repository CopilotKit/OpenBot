import { describe, expect, test } from "bun:test";
import { environmentFor } from "../src/environment";

/**
 * Whitespace-only `COMPUTER_TOKEN` used to be forwarded verbatim while the child trims and then
 * exits, a boot crash loop from a value the supervisor accepted. Invalid `COMPUTER_BROWSER_MODE`
 * was likewise forwarded to crash the child instead of failing fast here.
 */
describe("supervisor environment hardening", () => {
  test("omits a whitespace-only computer token", () => {
    expect(
      environmentFor("bot-1", {
        COMPUTER_TOKEN: "   ",
        COMPUTER_BROWSER_MODE: "headless",
      }),
    ).toEqual(["COMPUTER_BOT_ID=bot-1", "COMPUTER_BROWSER_MODE=headless"]);
  });

  test("trims a padded token", () => {
    expect(environmentFor("bot-1", { COMPUTER_TOKEN: "  secret  " })).toContain(
      "COMPUTER_TOKEN=secret",
    );
  });

  test("refuses an invalid browser mode instead of forwarding it", () => {
    expect(() =>
      environmentFor("bot-1", {
        COMPUTER_TOKEN: "s",
        COMPUTER_BROWSER_MODE: "fullscreen",
      }),
    ).toThrow(/headless or headed/);
  });

  test("accepts both valid modes", () => {
    for (const mode of ["headless", "headed"]) {
      expect(
        environmentFor("bot-1", {
          COMPUTER_TOKEN: "s",
          COMPUTER_BROWSER_MODE: mode,
        }),
      ).toContain(`COMPUTER_BROWSER_MODE=${mode}`);
    }
  });
});
