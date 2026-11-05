import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/src/config";

const root = fileURLToPath(new URL("..", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** Every `KEY=value` line, last one winning, as both `setting` in start.sh and Bun read it. */
function values(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    found.set(match[1], [...(found.get(match[1]) ?? []), match[2] ?? ""]);
  }
  return found;
}

async function run(envFile: string) {
  const child = Bun.spawn(
    ["bash", join(root, "scripts/use-personal-edition.sh")],
    {
      env: { ...process.env, ENV_FILE: envFile },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
}

async function fresh(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-personal-env-"));
  directories.push(directory);
  return join(directory, ".env");
}

const PERSONAL = {
  OPENBOT_EDITION: "personal",
  OPENBOT_SINGLE_USER: "true",
  TENANT_PACKAGE_DIR: "../examples/personal",
  OPENBOT_ONE_COMPUTER_EACH: "false",
  COMPUTER_SUPERVISOR_URL: "",
  AGENT_COMPUTER_URL: "http://localhost:4100",
  AUDIT_RETENTION_DAYS: "90",
};

test("turns a copy of .env.example into a personal edition, one line per setting", async () => {
  const envFile = await fresh();
  await copyFile(join(root, ".env.example"), envFile);
  await run(envFile);
  const lines = values(await readFile(envFile, "utf8"));
  for (const [name, value] of Object.entries(PERSONAL)) {
    expect({ name, values: lines.get(name) }).toEqual({
      name,
      values: [value],
    });
  }
});

test("starts from .env.example when there is no .env yet", async () => {
  const envFile = await fresh();
  await run(envFile);
  const lines = values(await readFile(envFile, "utf8"));
  expect(lines.get("OPENBOT_EDITION")).toEqual(["personal"]);
  // Everything else .env.example carries is still there to fill in.
  expect(lines.has("OPENAI_API_KEY")).toBe(true);
});

test("the result starts as a personal edition once the secrets are filled in", async () => {
  const envFile = await fresh();
  await run(envFile);
  const environment: Record<string, string> = {};
  for (const [name, found] of values(await readFile(envFile, "utf8")))
    environment[name] = found.at(-1) ?? "";
  // What a person fills in by hand; the shipped example leaves them empty.
  Object.assign(environment, {
    DATABASE_URL: environment.DATABASE_URL || "postgres://localhost/openbot",
    INTELLIGENCE_API_URL:
      environment.INTELLIGENCE_API_URL || "http://localhost:7100",
    INTELLIGENCE_GATEWAY_WS_URL:
      environment.INTELLIGENCE_GATEWAY_WS_URL || "ws://localhost:7103",
    INTELLIGENCE_API_KEY: environment.INTELLIGENCE_API_KEY || "key",
  });
  const config = loadConfig(environment);
  expect(config.edition).toBe("personal");
  expect(config.computer?.provider).toBe("shared");
  expect(config.tenantPackageDirectory).toBe("../examples/personal");
});

test("running it again changes nothing", async () => {
  const envFile = await fresh();
  await run(envFile);
  const once = await readFile(envFile, "utf8");
  await run(envFile);
  expect(await readFile(envFile, "utf8")).toBe(once);
});
