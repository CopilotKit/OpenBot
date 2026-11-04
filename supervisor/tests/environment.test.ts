import { describe, expect, test } from "bun:test";
import { environmentFor } from "../src/environment";

/**
 * `HMAC-SHA256("secret", "openbot computer token v1\nbot:invoice-collector")`, worked out with
 * `openssl dgst -sha256 -hmac secret` rather than by the code under test: the computer's own token,
 * which is never the deployment's (shared/computer-token.ts).
 */
const INVOICE_COLLECTOR_TOKEN =
  "31db2a55d194c376fc535e591cc965ed9c597031945934f1913254fb8ca7e1cc";

describe("what the supervisor tells a computer about its browser", () => {
  test("passes the deployment's browser mode to an isolated Bot's computer", () => {
    expect(
      environmentFor(
        { kind: "bot", id: "invoice-collector" },
        { COMPUTER_TOKEN: "secret", COMPUTER_BROWSER_MODE: "headed" },
      ),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "COMPUTER_SEPARATE_WORKSPACES=on",
      `COMPUTER_TOKEN=${INVOICE_COLLECTOR_TOKEN}`,
      "COMPUTER_BROWSER_MODE=headed",
    ]);
  });

  test("does not invent a browser mode when the deployment left it unset", () => {
    expect(
      environmentFor(
        { kind: "bot", id: "invoice-collector" },
        { COMPUTER_TOKEN: "secret" },
      ),
    ).toEqual([
      "COMPUTER_BOT_ID=invoice-collector",
      "COMPUTER_SEPARATE_WORKSPACES=on",
      `COMPUTER_TOKEN=${INVOICE_COLLECTOR_TOKEN}`,
    ]);
  });

  test("a person's computer gives each of their Bots its own folder, and names no Bot", () => {
    // It carries every Bot the person uses, so no one Bot is its default, and files are kept apart
    // per Bot the way browser profiles already are.
    const environment = environmentFor(
      { kind: "person", id: "u-ada" },
      { COMPUTER_TOKEN: "secret" },
    );
    expect(environment).toContain("COMPUTER_SEPARATE_WORKSPACES=on");
    expect(
      environment.some((line) => line.startsWith("COMPUTER_BOT_ID=")),
    ).toBe(false);
    // Told whose it is, so Record runs in its Bots' browsers there.
    expect(environment).toContain("COMPUTER_PERSON_ID=u-ada");
  });
});
