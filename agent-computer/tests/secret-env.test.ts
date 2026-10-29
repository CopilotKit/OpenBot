import { describe, expect, test } from "bun:test";
import { hideProcessFromChildren, takeSecretFromEnv } from "../src/secret-env";

describe("a secret read from the environment", () => {
  test("is returned trimmed and removed, so no child inherits it", () => {
    const env: Record<string, string | undefined> = {
      COMPUTER_TOKEN: "  s3cret  ",
      PATH: "/usr/bin",
    };
    expect(takeSecretFromEnv("COMPUTER_TOKEN", env)).toBe("s3cret");
    expect("COMPUTER_TOKEN" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });

  test("an absent or blank one is undefined, and still removed", () => {
    const env: Record<string, string | undefined> = { COMPUTER_TOKEN: "   " };
    expect(takeSecretFromEnv("COMPUTER_TOKEN", env)).toBeUndefined();
    expect("COMPUTER_TOKEN" in env).toBe(false);
    expect(takeSecretFromEnv("COMPUTER_TOKEN", {})).toBeUndefined();
  });

  test("a child started afterwards does not see it", async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      OPENBOT_TEST_SECRET: "do-not-inherit",
    };
    takeSecretFromEnv("OPENBOT_TEST_SECRET", env);
    const child = Bun.spawn(["/usr/bin/env"], {
      env: env as Record<string, string>,
      stdout: "pipe",
    });
    const printed = await new Response(child.stdout).text();
    expect(printed).not.toContain("do-not-inherit");
  });
});

describe("hiding the process from its children", () => {
  test("is skipped, and says why, when asked to stay dumpable", async () => {
    expect(await hideProcessFromChildren({ COMPUTER_DUMPABLE: "on" })).toEqual({
      hidden: false,
      reason: "COMPUTER_DUMPABLE=on",
    });
  });

  test("is skipped off Linux", async () => {
    const answer = await hideProcessFromChildren({}, "darwin");
    expect(answer.hidden).toBe(false);
  });
});
