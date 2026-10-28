import { describe, expect, test } from "bun:test";
import { environmentFor } from "../../supervisor/src/environment";

describe("connector tokens never reach a Bot's computer", () => {
  test("a computer's environment carries none of the deployment's secrets", () => {
    const placeholder = "placeholder-connector-value-0000";
    const env = environmentFor(
      { kind: "bot", id: "bot-1" },
      {
        COMPUTER_TOKEN: "computer-token",
        KEY_ENCRYPTION_KEY: placeholder,
        COMPOSIO_API_KEY: placeholder,
        GOOGLE_OAUTH_CLIENT_SECRET: placeholder,
        DATABASE_URL: `postgres://openbot:${placeholder}@127.0.0.1/openbot`,
        INTELLIGENCE_API_KEY: placeholder,
        SLACK_BOT_TOKEN: placeholder,
        EGRESS_PROXY_BOT_1: "http://127.0.0.1:3128",
      },
    );
    expect(env.join("\n")).not.toContain(placeholder);
    expect(env).toContain("COMPUTER_BOT_ID=bot-1");
    // A person's computer is held to the same rule.
    const personal = environmentFor(
      { kind: "person", id: "u-1" },
      { COMPUTER_TOKEN: "computer-token", KEY_ENCRYPTION_KEY: placeholder },
    );
    expect(personal.join("\n")).not.toContain(placeholder);
  });
});
