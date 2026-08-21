import { describe, expect, test } from "bun:test";
import { commandEnvironment } from "../src/shell";

/**
 * What a Bot's command can read out of the deployment.
 *
 * The case that matters is the first one. A command inherits whatever the computer process holds,
 * and in the one-container image that is the API's environment: the key that decrypts every stored
 * credential, the database URL, the model key. A test that only checked `PATH` survives would have
 * been green while `env` returned all of them.
 */

const DEPLOYMENT = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/pwuser",
  LANG: "C.UTF-8",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  DATABASE_URL: "postgres://openbot:hunter2@127.0.0.1:5432/openbot",
  OPENAI_API_KEY: "sk-live-not-for-a-bot",
  COMPUTER_TOKEN: "the-secret-between-the-api-and-this-process",
  INTELLIGENCE_API_KEY: "cpk-live",
  COPILOTKIT_LICENSE_TOKEN: "licence",
  AGENT_TOOL_TOKEN: "per-agent-callback",
  SUPERVISOR_TOKEN: "supervisor",
};

describe("the environment one command gets", () => {
  test("the deployment's secrets are not in it", () => {
    const environment = commandEnvironment(DEPLOYMENT, "/workspace");

    for (const name of [
      "KEY_ENCRYPTION_KEY",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "COMPUTER_TOKEN",
      "INTELLIGENCE_API_KEY",
      "COPILOTKIT_LICENSE_TOKEN",
      "AGENT_TOOL_TOKEN",
      "SUPERVISOR_TOKEN",
    ]) {
      expect(environment[name]).toBeUndefined();
    }
  });

  test("what a command needs to run at all is still there", () => {
    const environment = commandEnvironment(DEPLOYMENT, "/workspace");

    expect(environment.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(environment.LANG).toBe("C.UTF-8");
  });

  test("home is the workspace, whatever the deployment's home was", () => {
    // The file tools and a command have to see one directory, and the inherited HOME is the
    // container user's, not this Bot's.
    const environment = commandEnvironment(DEPLOYMENT, "/workspace");

    expect(environment.HOME).toBe("/workspace");
  });

  test("a proxied deployment keeps its proxy variables", () => {
    // Without these an `apt-get install` behind a corporate proxy hangs rather than failing, and
    // installing a tool is most of why a Bot has a shell.
    const environment = commandEnvironment(
      {
        ...DEPLOYMENT,
        HTTPS_PROXY: "http://proxy.internal:8080",
        no_proxy: "127.0.0.1,localhost",
      },
      "/workspace",
    );

    expect(environment.HTTPS_PROXY).toBe("http://proxy.internal:8080");
    expect(environment.no_proxy).toBe("127.0.0.1,localhost");
  });

  test("a deployment can name what else a command should see", () => {
    const environment = commandEnvironment(
      {
        ...DEPLOYMENT,
        GITHUB_TOKEN: "ghp-for-the-bot",
        BUILD_CHANNEL: "nightly",
        COMPUTER_SHELL_ENV: "GITHUB_TOKEN, BUILD_CHANNEL",
      },
      "/workspace",
    );

    // Spaces around a name are an operator writing a list, not a different variable.
    expect(environment.GITHUB_TOKEN).toBe("ghp-for-the-bot");
    expect(environment.BUILD_CHANNEL).toBe("nightly");
    // Naming two does not bring the rest with them.
    expect(environment.KEY_ENCRYPTION_KEY).toBeUndefined();
  });

  test("naming a variable that is not set does not invent an empty one", () => {
    // `test -z "$X"` and `test -v X` are different questions, and a command that branches on the
    // second should see what the deployment actually has.
    const environment = commandEnvironment(
      { ...DEPLOYMENT, COMPUTER_SHELL_ENV: "NEVER_SET" },
      "/workspace",
    );

    expect("NEVER_SET" in environment).toBe(false);
  });

  test("the pass-through list cannot move home out of the workspace", () => {
    const environment = commandEnvironment(
      { ...DEPLOYMENT, COMPUTER_SHELL_ENV: "HOME" },
      "/workspace",
    );

    expect(environment.HOME).toBe("/workspace");
  });
});
