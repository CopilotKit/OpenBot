import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  localChromeConfiguration,
  requireAvailablePort,
  requireInstalledChrome,
} from "../../scripts/start-local-chrome-computer";

describe("starting the local computer", () => {
  test("requires the existing API token and never includes it in an error", () => {
    expect(() =>
      localChromeConfiguration({}, "darwin", "/Users/operator"),
    ).toThrow("COMPUTER_TOKEN");
  });

  test("isolates profiles and files from inherited paths", () => {
    const config = localChromeConfiguration(
      {
        COMPUTER_TOKEN: "test-token",
        OPENBOT_LOCAL_COMPUTER_DIR: "/tmp/openbot-local-test",
        PROFILES_DIR:
          "/Users/operator/Library/Application Support/Google/Chrome",
        WORKSPACE_DIR: "/Users/operator",
      },
      "darwin",
      "/Users/operator",
    );
    expect(config.env.PROFILES_DIR).toBe("/tmp/openbot-local-test/profiles");
    expect(config.env.WORKSPACE_DIR).toBe("/tmp/openbot-local-test/workspace");
    expect(config.env.COMPUTER_BROWSER_BACKEND).toBe("local-chrome");
    expect(config.env.COMPUTER_BROWSER_MODE).toBe("headed");
    expect(config.env.COMPUTER_SANDBOX).toBe("on");
    expect(config.env.PORT).toBe("4101");
    expect(config.env.COMPUTER_TOKEN).toBe("test-token");
  });

  test("uses platform user data roots", () => {
    const env = { COMPUTER_TOKEN: "test-token" };
    expect(
      localChromeConfiguration(env, "darwin", "/Users/operator").root,
    ).toBe(
      "/Users/operator/Library/Application Support/OpenBot/local-computer",
    );
    expect(
      localChromeConfiguration(
        { ...env, XDG_DATA_HOME: "/data" },
        "linux",
        "/home/operator",
      ).root,
    ).toBe("/data/openbot/local-computer");
    expect(
      localChromeConfiguration(
        { ...env, LOCALAPPDATA: "C:\\Users\\Operator\\AppData\\Local" },
        "win32",
        "C:\\Users\\Operator",
      ).root,
    ).toBe("C:\\Users\\Operator\\AppData\\Local\\OpenBot\\local-computer");
  });

  test("rejects a relative data directory, invalid port and an incompatible backend", () => {
    const env = { COMPUTER_TOKEN: "test-token" };
    expect(() =>
      localChromeConfiguration({
        ...env,
        OPENBOT_LOCAL_COMPUTER_DIR: "profiles",
      }),
    ).toThrow("absolute");
    expect(() => localChromeConfiguration({ ...env, PORT: "0" })).toThrow(
      "PORT",
    );
    expect(() =>
      localChromeConfiguration({ ...env, COMPUTER_BROWSER_BACKEND: "managed" }),
    ).toThrow("COMPUTER_BROWSER_BACKEND");
    expect(() =>
      localChromeConfiguration({ ...env, COMPUTER_BROWSER_MODE: "headless" }),
    ).toThrow("headed");
  });

  test("missing token exits before starting the computer or creating data", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../scripts/start-local-chrome-computer.ts"),
      ],
      {
        env: { COMPUTER_TOKEN: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("COMPUTER_TOKEN is required");
  });

  test("missing installed Chrome fails clearly without launching a fallback", async () => {
    await expect(requireInstalledChrome({}, "win32")).rejects.toThrow(
      "Google Chrome was not found",
    );
  });

  test("occupied loopback port fails instead of choosing another port", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      await expect(requireAvailablePort(address.port)).rejects.toThrow(
        `Cannot listen on 127.0.0.1:${address.port}`,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
