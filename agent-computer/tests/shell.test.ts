import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell, environmentForCommand } from "../src/shell";

/**
 * What a command on the computer is allowed to see.
 *
 * The case that matters is a secret that already sits on the process: KEY_ENCRYPTION_KEY in the
 * one-container image, COMPUTER_TOKEN under Compose. Spreading `process.env` into the child makes
 * `env` print them. These tests build the map a spawn would receive, then run a real command against
 * it, so a refactor that only updates the helper cannot go green while the child still inherits.
 */

const workspaceHome = "/workspace/sales";

const secrets = {
  KEY_ENCRYPTION_KEY: "deployment-key",
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1/openbot",
  OPENAI_API_KEY: "sk-secret",
  COMPUTER_TOKEN: "computer-token",
  INTELLIGENCE_API_KEY: "cpk-secret",
} as const;

const allowed = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm-256color",
  HTTP_PROXY: "http://proxy.internal:8080",
  http_proxy: "http://proxy.internal:8080",
  HTTPS_PROXY: "http://proxy.internal:8080",
} as const;

function source(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return { ...secrets, ...allowed, HOME: "/root", ...extra };
}

describe("what a command inherits", () => {
  test("PATH, locale, terminal and proxy variables pass", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env.PATH).toBe(allowed.PATH);
    expect(env.LANG).toBe(allowed.LANG);
    expect(env.LC_ALL).toBe(allowed.LC_ALL);
    expect(env.TERM).toBe(allowed.TERM);
    expect(env.HTTP_PROXY).toBe(allowed.HTTP_PROXY);
    expect(env.http_proxy).toBe(allowed.http_proxy);
    expect(env.HTTPS_PROXY).toBe(allowed.HTTPS_PROXY);
  });

  test("a secret sitting in the process environment does not", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env).not.toHaveProperty("KEY_ENCRYPTION_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("COMPUTER_TOKEN");
    expect(env).not.toHaveProperty("INTELLIGENCE_API_KEY");
    expect(JSON.stringify(env)).not.toContain("deployment-key");
    expect(JSON.stringify(env)).not.toContain("sk-secret");
  });

  test("HOME is the workspace, not the process's home", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env.HOME).toBe(workspaceHome);
  });

  test("COMPUTER_SHELL_ENV names extras, read as names", () => {
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "JAVA_HOME, GOPATH",
        JAVA_HOME: "/opt/java",
        GOPATH: "/opt/go",
      }),
      workspaceHome,
    );
    expect(env.JAVA_HOME).toBe("/opt/java");
    expect(env.GOPATH).toBe("/opt/go");
    expect(env).not.toHaveProperty("COMPUTER_SHELL_ENV");
  });

  test("naming a secret in COMPUTER_SHELL_ENV is an operator's decision", () => {
    const env = environmentForCommand(
      source({ COMPUTER_SHELL_ENV: "KEY_ENCRYPTION_KEY" }),
      workspaceHome,
    );
    expect(env.KEY_ENCRYPTION_KEY).toBe(secrets.KEY_ENCRYPTION_KEY);
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("a name that is not a name is not read as one", () => {
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "JAVA_HOME,KEY_ENCRYPTION_KEY;rm,FOO=bar",
        JAVA_HOME: "/opt/java",
      }),
      workspaceHome,
    );
    expect(env.JAVA_HOME).toBe("/opt/java");
    expect(env).not.toHaveProperty("KEY_ENCRYPTION_KEY");
    expect(env).not.toHaveProperty("FOO");
  });

  test("HOME cannot be redirected through COMPUTER_SHELL_ENV", () => {
    const env = environmentForCommand(
      source({ COMPUTER_SHELL_ENV: "HOME", HOME: "/root" }),
      workspaceHome,
    );
    expect(env.HOME).toBe(workspaceHome);
  });
});

describe("the command that actually runs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-shell-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("env in the child does not list a secret from the parent", async () => {
    const result = await createShell(root, source()).run({
      command: "printenv",
    });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain(`HOME=${root}`);
    expect(result.stdout).toContain(`HTTP_PROXY=${allowed.HTTP_PROXY}`);
    expect(result.stdout).not.toContain("KEY_ENCRYPTION_KEY");
    expect(result.stdout).not.toContain("deployment-key");
    expect(result.stdout).not.toContain("sk-secret");
    expect(result.stdout).not.toContain("computer-token");
  });

  test("a name in COMPUTER_SHELL_ENV is in the child", async () => {
    const result = await createShell(
      root,
      source({ COMPUTER_SHELL_ENV: "JAVA_HOME", JAVA_HOME: "/opt/java" }),
    ).run({ command: "printenv JAVA_HOME" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/opt/java");
  });
});
