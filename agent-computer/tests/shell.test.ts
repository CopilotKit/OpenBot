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

  test("a proxy URL's userinfo does not pass", () => {
    const env = environmentForCommand(
      source({
        HTTP_PROXY: "http://bot:s3cret@proxy.internal:8080",
        HTTPS_PROXY: "https://bot:p%40ss@proxy.internal:8443",
      }),
      workspaceHome,
    );
    expect(env.HTTP_PROXY).toBe("http://proxy.internal:8080");
    expect(env.HTTPS_PROXY).toBe("https://proxy.internal:8443");
    expect(JSON.stringify(env)).not.toContain("s3cret");
    expect(JSON.stringify(env)).not.toContain("p%40ss");
    expect(JSON.stringify(env)).not.toContain("p@ss");
  });

  test("a proxy without userinfo is left alone", () => {
    const env = environmentForCommand(source(), workspaceHome);
    expect(env.HTTP_PROXY).toBe(allowed.HTTP_PROXY);
  });

  test("naming a credentialed proxy in COMPUTER_SHELL_ENV is an operator's decision", () => {
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "HTTP_PROXY",
        HTTP_PROXY: "http://bot:s3cret@proxy.internal:8080",
      }),
      workspaceHome,
    );
    expect(env.HTTP_PROXY).toBe("http://bot:s3cret@proxy.internal:8080");
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
  test("a package install is not left waiting for a prompt", async () => {
    // apt-get reads DEBIAN_FRONTEND. Interactive, it stops for an answer nobody is there to give,
    // and the command reaches its timeout looking like a broken package rather than a question.
    const result = await createShell(root, source()).run({
      command: "printenv DEBIAN_FRONTEND",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("noninteractive");
  });

  test("env in the child does not list a proxy password", async () => {
    const result = await createShell(
      root,
      source({ HTTP_PROXY: "http://bot:s3cret@proxy.internal:8080" }),
    ).run({ command: "printenv HTTP_PROXY" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("http://proxy.internal:8080");
    expect(result.stdout).not.toContain("s3cret");
  });

  test("an operator can still choose the frontend themselves", async () => {
    const result = await createShell(
      root,
      source({
        COMPUTER_SHELL_ENV: "DEBIAN_FRONTEND",
        DEBIAN_FRONTEND: "teletype",
      }),
    ).run({ command: "printenv DEBIAN_FRONTEND" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("teletype");
  });
  test("a file the Bot left behind does not run before its command", async () => {
    // computer_write_file lets a Bot write anywhere in its workspace, and HOME is the workspace. A
    // login shell would source this first, so a later command would run Bot-authored code while the
    // audit row recorded only the command that was asked for.
    await Bun.write(
      join(root, ".bash_profile"),
      'echo "profile ran"\nexport MARKER=hijacked\n',
    );

    const result = await createShell(root, source()).run({
      command: 'echo "[${MARKER:-clean}]"',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("profile ran");
    expect(result.stdout.trim()).toBe("[clean]");
  });
  test("BASH_ENV is not in the map a command receives", () => {
    /*
     * The one startup file a non-interactive shell still reads. `bash -c` sources no login files, but
     * it does expand BASH_ENV and run what it names, on bash 3.2 and 5.2 alike. Nothing else closes
     * that path: it is closed only by BASH_ENV not being in the map, so it is asserted here rather
     * than assumed. Same for the option variables bash reads from its environment.
     */
    const env = environmentForCommand(
      source({
        BASH_ENV: "/workspace/profile.sh",
        SHELLOPTS: "xtrace",
        BASHOPTS: "expand_aliases",
        CDPATH: "/workspace",
        GLOBIGNORE: "*",
      }),
      workspaceHome,
    );

    expect(env.BASH_ENV).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    expect(env.BASHOPTS).toBeUndefined();
    expect(env.CDPATH).toBeUndefined();
    expect(env.GLOBIGNORE).toBeUndefined();
  });

  test("COMPUTER_SHELL_ENV cannot hand back an execution hook", () => {
    /*
     * The rest of that setting is an operator's decision to make. This is not: BASH_ENV names a file
     * bash runs before the command, so passing it would reopen the hole `-c` closed, with the
     * reasoning for `-c` sitting a few lines above looking satisfied. Refused rather than omitted, so
     * the boundary does not depend on nobody adding a `BASH_*` convenience later.
     */
    const env = environmentForCommand(
      source({
        COMPUTER_SHELL_ENV: "BASH_ENV,LD_PRELOAD,ENV,SHELLOPTS,JAVA_HOME",
        BASH_ENV: "/workspace/hook.sh",
        LD_PRELOAD: "/workspace/hook.so",
        ENV: "/workspace/hook.sh",
        SHELLOPTS: "xtrace",
        JAVA_HOME: "/opt/java",
      }),
      workspaceHome,
    );

    expect(env.BASH_ENV).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.ENV).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
    // A name that only carries information still passes, so the refusal is targeted rather than a
    // second allow list nobody can extend.
    expect(env.JAVA_HOME).toBe("/opt/java");
  });
});

describe("what a command cannot do to the computer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-shell-limits-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a command that backgrounds a process is still stopped", async () => {
    /*
     * `child.kill` signals bash alone. The sleep and the cat below hold the pipes bash inherited, so
     * `close` never fires and the awaited promise never settles: the command outlives its own limit
     * and the caller waits for something else to give up. Killing the process group ends all of it.
     */
    const started = Date.now();
    const result = await createShell(root, source()).run({
      command: "sleep 30 | cat",
      timeoutMs: 1_500,
    });

    expect(result.timedOut).toBe(true);
    // Settles on its own limit rather than hanging until something upstream times out.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  test("a noisy command does not grow without limit", async () => {
    // The clamp ran only after close, so this allocated until the process that owns the browser died.
    const result = await createShell(root, source()).run({
      command: "head -c 3000000 /dev/zero | tr '\\0' 'a'",
      timeoutMs: 20_000,
    });

    expect(result.truncated).toBe(true);
    // Held to the kept size and a margin, not to the three megabytes the command produced.
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(200 * 1024);
  }, 30_000);

  test("a timeout of zero is not a command killed before it runs", async () => {
    // Only Math.min was applied, so this fired setTimeout immediately and reported a timeout for a
    // command that never had a chance to start.
    const result = await createShell(root, source()).run({
      command: 'echo "ran"',
      timeoutMs: 0,
    });

    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("ran");
  }, 15_000);
});
