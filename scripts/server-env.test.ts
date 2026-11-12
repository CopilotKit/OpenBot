import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envLine, onThisMachine, serverEnvironment } from "./server-env";

/**
 * What `scripts/start.sh` hands the server's container: `.env`, with the environment winning over it,
 * as Bun read the two when the server ran on the host.
 */

test("the environment wins over .env, an empty export included, and absent keys stay absent", () => {
  const file = serverEnvironment(
    [
      "OPENAI_API_KEY=sk-from-dotenv",
      "OPENBOT_LEARNING_AUTO_ASSIGN=true",
      'BETTER_AUTH_URL="http://127.0.0.1:3001"',
    ].join("\n"),
    {
      OPENBOT_LEARNING_AUTO_ASSIGN: "false",
      GOOGLE_OAUTH_CLIENT_ID: "",
      PATH: "/usr/bin",
    },
    ["GOOGLE_OAUTH_CLIENT_ID", "OKTA_OAUTH_ISSUER"],
  );
  expect(file.split("\n")).toEqual([
    "OPENAI_API_KEY='sk-from-dotenv'",
    "OPENBOT_LEARNING_AUTO_ASSIGN='false'",
    "BETTER_AUTH_URL='http://127.0.0.1:3001'",
    "GOOGLE_OAUTH_CLIENT_ID=''",
    "",
  ]);
});

test("settings a run makes without writing them down still reach the server", () => {
  const file = serverEnvironment(
    "",
    {
      OPENBOT_EDITION: "personal",
      OPENBOT_MODEL_CAPABILITIES_URL: "off",
      DO_NOT_TRACK: "1",
    },
    [],
  );
  expect(file).toContain("OPENBOT_EDITION='personal'");
  expect(file).toContain("OPENBOT_MODEL_CAPABILITIES_URL='off'");
  expect(file).toContain("DO_NOT_TRACK='1'");
});

test("a model endpoint on this machine is written as the container reaches it", () => {
  for (const [given, reached] of [
    ["http://127.0.0.1:46400", "http://host.docker.internal:46400"],
    ["http://localhost:11434/v1", "http://host.docker.internal:11434/v1"],
    ["http://[::1]:8080/v1beta", "http://host.docker.internal:8080/v1beta"],
    ["https://api.anthropic.com", "https://api.anthropic.com"],
    ["http://localhost.example.com/v1", "http://localhost.example.com/v1"],
  ])
    expect(onThisMachine(given)).toBe(reached);
  expect(
    serverEnvironment("ANTHROPIC_BASE_URL=http://127.0.0.1:46400", {}, []),
  ).toBe("ANTHROPIC_BASE_URL='http://host.docker.internal:46400'\n");
  // The browser's addresses are the browser's, and stay as they are.
  expect(
    serverEnvironment("OPENBOT_APP_URL=http://127.0.0.1:3010", {}, []),
  ).toBe("OPENBOT_APP_URL='http://127.0.0.1:3010'\n");
});

test("values reach Compose literally, or are refused by name", () => {
  expect(envLine("A", 'x$HOME\\n"y"')).toBe("A='x$HOME\\n\"y\"'");
  expect(envLine("B", "it's")).toBe('B="it\'s"');
  expect(() => envLine("C", "it's $HOME")).toThrow(/^C has a value/);
  expect(() => envLine("D", "one\ntwo")).toThrow(/^D has a value/);
});

/** Compose itself reads the file back as written. */
test("Compose reads every line back as the value it was given", () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-server-env-"));
  try {
    const values = {
      PLAIN: "value",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture.
      DOLLAR: "a$HOME${PATH}b",
      QUOTE: "it's",
      DOUBLE: 'say "hi"',
      HASH: "before # after",
    };
    writeFileSync(
      join(directory, "server.env"),
      serverEnvironment("", values, Object.keys(values)),
    );
    writeFileSync(
      join(directory, "compose.yml"),
      "services:\n  a:\n    image: busybox:1.37\n    env_file: [server.env]\n",
    );
    const config = JSON.parse(
      execFileSync(
        "docker",
        ["compose", "--env-file", "/dev/null", "config", "--format", "json"],
        {
          cwd: directory,
          env: { PATH: process.env.PATH ?? "" },
          encoding: "utf8",
        },
      ),
    ) as { services: { a: { environment: Record<string, string> } } };
    // `config` prints its model as a Compose file, where a literal `$` is written `$$`.
    const read = Object.fromEntries(
      Object.entries(config.services.a.environment).map(([name, value]) => [
        name,
        value.replaceAll("$$", "$"),
      ]),
    );
    expect(read).toEqual(values);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Run as start.sh runs it, from a directory with a `.env` of its own: what it writes comes from the
 * file it is given and the environment it is handed, never from a `.env` Bun loads behind it.
 */
test("the script writes the file it was given, as start.sh runs it", () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-server-env-"));
  try {
    writeFileSync(join(directory, ".env"), "OPENAI_API_KEY=sk-test\n");
    const output = join(directory, "server.env");
    const elsewhere = mkdtempSync(join(tmpdir(), "openbot-server-env-cwd-"));
    writeFileSync(join(elsewhere, ".env"), "OPENAI_API_KEY=not-this-one\n");
    try {
      execFileSync(
        process.execPath,
        [
          "--no-env-file",
          join(import.meta.dir, "server-env.ts"),
          join(directory, ".env"),
          output,
        ],
        { cwd: elsewhere, env: { PATH: process.env.PATH ?? "" } },
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(readFileSync(output, "utf8")).toContain("OPENAI_API_KEY='sk-test'");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
