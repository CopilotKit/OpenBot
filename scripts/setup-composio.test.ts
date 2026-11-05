import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { RunCli } from "../server/src/learning/ensure-container";
import { setupComposio } from "./setup-composio";

const directories: string[] = [];
const installationId = "568ea6c4-6917-4aba-aabc-9e7aaef4bdf1";
const key = "synthetic-project-key";
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  content = "COMPOSIO_API_KEY=\n# Other settings\nOPENAI_API_KEY=synthetic-model\n",
) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-composio-setup-"));
  directories.push(directory);
  const envPath = join(directory, ".env");
  const identityPath = join(directory, ".env.openbot-installation-id");
  await writeFile(envPath, content);
  const calls: string[][] = [];
  const provision: RunCli = async (args, cwd) => {
    expect(cwd).toBe(directory);
    calls.push(args);
    const persisted = parseEnv(
      await readFile(identityPath, "utf8"),
    ).OPENBOT_INSTALLATION_ID;
    expect(persisted).toBe(args[4]);
    if (process.platform !== "win32")
      expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
    await writeFile(
      envPath,
      `${await readFile(envPath, "utf8")}\nCOMPOSIO_API_KEY=${key}\n`,
      { mode: 0o600 },
    );
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "completed",
        installation_id: args[4],
        project_id: "project-synthetic",
        environment_file_written: true,
        reused: false,
      }),
    };
  };
  return {
    directory,
    envPath,
    identityPath,
    calls,
    provision,
    options: { directory, environment: {} },
  };
}

test("persists a private fresh identity before provisioning, validates metadata and reloads the written key", async () => {
  const f = await fixture();
  const environment: NodeJS.ProcessEnv = {};
  expect(
    await setupComposio({ ...f.options, environment, runCli: f.provision }),
  ).toBe("configured");
  const id = parseEnv(
    await readFile(f.identityPath, "utf8"),
  ).OPENBOT_INSTALLATION_ID;
  if (!id) throw new Error("Setup did not persist an installation identity.");
  expect(id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(f.calls).toEqual([
    [
      "integrations",
      "composio",
      "provision",
      "--installation-id",
      id,
      "--env-path",
      f.envPath,
      "--json",
    ],
  ]);
  expect(environment.COMPOSIO_API_KEY).toBe(key);
  expect(await readFile(f.envPath, "utf8")).toContain(
    "# Other settings\nOPENAI_API_KEY=synthetic-model",
  );
});

test.each([
  ["a file key", "COMPOSIO_API_KEY=existing-project-key\n", {}],
  [
    "a file key behind a blank exported value",
    "COMPOSIO_API_KEY=existing-project-key\n",
    { COMPOSIO_API_KEY: "   " },
  ],
  [
    "an environment key",
    "COMPOSIO_API_KEY=\n",
    { COMPOSIO_API_KEY: "existing-project-key" },
  ],
  [
    "explicit Arcade",
    "OPENBOT_BROKER_PROVIDER=arcade\nARCADE_API_KEY=existing-arcade\n",
    {},
  ],
  ["automatic Arcade", "ARCADE_API_KEY=existing-arcade\n", {}],
  [
    "an Arcade file key behind a blank exported value",
    "ARCADE_API_KEY=existing-arcade\n",
    { ARCADE_API_KEY: "   " },
  ],
] as const)(
  "preserves %s without invoking the CLI or allocating an identity",
  async (_, content, environment) => {
    const f = await fixture(content);
    expect(
      await setupComposio({ ...f.options, environment, runCli: f.provision }),
    ).toBe("preserved");
    expect(await readFile(f.envPath, "utf8")).toBe(content);
    expect(f.calls).toEqual([]);
    expect(await Bun.file(f.identityPath).exists()).toBe(false);
  },
);

test("replay after a successful setup preserves the existing project key", async () => {
  const f = await fixture();
  await setupComposio({ ...f.options, runCli: f.provision });
  const saved = await readFile(f.envPath, "utf8");
  expect(await setupComposio({ ...f.options, runCli: f.provision })).toBe(
    "preserved",
  );
  expect(f.calls).toHaveLength(1);
  expect(await readFile(f.envPath, "utf8")).toBe(saved);
});

test("separate installations never reuse a shared packaged deployment identity", async () => {
  const first = await fixture("DEPLOYMENT_ID=shared-package-tenant\n");
  const second = await fixture("DEPLOYMENT_ID=shared-package-tenant\n");
  await setupComposio({ ...first.options, runCli: first.provision });
  await setupComposio({ ...second.options, runCli: second.provision });
  expect(await readFile(first.identityPath, "utf8")).not.toBe(
    await readFile(second.identityPath, "utf8"),
  );
});

test("an explicit Composio selection can prepare its key while retaining an Arcade key", async () => {
  const content =
    "OPENBOT_BROKER_PROVIDER=composio\nARCADE_API_KEY=existing-arcade\n";
  const f = await fixture(content);
  expect(await setupComposio({ ...f.options, runCli: f.provision })).toBe(
    "configured",
  );
  expect(await readFile(f.envPath, "utf8")).toStartWith(content);
});

test("a missing npx names its prerequisite without relaying child output", async () => {
  const f = await fixture();
  const operation = setupComposio({
    ...f.options,
    runCli: async () => ({ exitCode: 127, stdout: "secret-child-output" }),
  });
  await expect(operation).rejects.toThrow("Install Node.js with npx");
  await expect(operation).rejects.not.toThrow("secret-child-output");
});

test("invalid configured identities fail before starting the CLI", async () => {
  const f = await fixture("OPENBOT_INSTALLATION_ID=shared-package-tenant\n");
  await expect(
    setupComposio({ ...f.options, runCli: f.provision }),
  ).rejects.toThrow("must be a UUID");
  expect(f.calls).toEqual([]);
  expect(await Bun.file(f.identityPath).exists()).toBe(false);
});

test("an unreadable identity fails before provisioning and retains the original environment", async () => {
  const f = await fixture();
  const before = await readFile(f.envPath, "utf8");
  await mkdir(f.identityPath);
  await expect(
    setupComposio({ ...f.options, runCli: f.provision }),
  ).rejects.toThrow("Could not persist");
  expect(f.calls).toEqual([]);
  expect(await readFile(f.envPath, "utf8")).toBe(before);
});

test("a missing environment file never starts provisioning", async () => {
  const f = await fixture();
  await rm(f.envPath);
  await expect(
    setupComposio({ ...f.options, runCli: f.provision }),
  ).rejects.toThrow("copying .env.example");
  expect(f.calls).toEqual([]);
});

test("an invalid provider is reported without provisioning", async () => {
  const f = await fixture("OPENBOT_BROKER_PROVIDER=invalid\n");
  await expect(
    setupComposio({ ...f.options, runCli: f.provision }),
  ).rejects.toThrow("must be composio or arcade");
  expect(f.calls).toEqual([]);
});

test("an interrupted attempt keeps its identity for the next process and does not leak child errors", async () => {
  const f = await fixture("DEPLOYMENT_ID=shared-package-tenant\n");
  await expect(
    setupComposio({
      ...f.options,
      runCli: async () => {
        throw new Error("secret-child-stderr");
      },
    }),
  ).rejects.toThrow("Sign in");
  const saved = await readFile(f.identityPath, "utf8");
  expect(saved).not.toContain("shared-package-tenant");
  await setupComposio({ ...f.options, runCli: f.provision });
  expect(await readFile(f.identityPath, "utf8")).toBe(saved);
});

test("concurrent setup attempts share the same complete persisted identity", async () => {
  const f = await fixture();
  const ids: string[] = [];
  const runCli: RunCli = async (args) => {
    ids.push(args[4]);
    expect(
      parseEnv(await readFile(f.identityPath, "utf8")).OPENBOT_INSTALLATION_ID,
    ).toBe(args[4]);
    return { exitCode: 1, stdout: "" };
  };
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => setupComposio({ ...f.options, runCli })),
  );
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(1);
});

test.each(["configured", "saved"] as const)(
  "canonicalizes an uppercase %s UUID before matching normalized CLI metadata",
  async (source) => {
    const uppercase = installationId.toUpperCase();
    const f = await fixture(
      source === "configured" ? `OPENBOT_INSTALLATION_ID=${uppercase}\n` : "",
    );
    if (source === "saved")
      await writeFile(f.identityPath, `OPENBOT_INSTALLATION_ID=${uppercase}\n`);
    const calls: string[][] = [];
    const runCli: RunCli = async (args) => {
      calls.push(args);
      await writeFile(f.envPath, `COMPOSIO_API_KEY=${key}\n`);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "completed",
          installation_id: installationId,
          project_id: "project-synthetic",
          environment_file_written: true,
          reused: source === "saved",
        }),
      };
    };
    expect(await setupComposio({ ...f.options, runCli })).toBe("configured");
    expect(calls[0][4]).toBe(installationId);
    if (source === "configured")
      expect(
        parseEnv(await readFile(f.identityPath, "utf8"))
          .OPENBOT_INSTALLATION_ID,
      ).toBe(installationId);
  },
);

test("accepts an explicit UUID but rejects conflicting saved identity", async () => {
  const f = await fixture(`OPENBOT_INSTALLATION_ID=${installationId}\n`);
  await expect(
    setupComposio({
      ...f.options,
      runCli: async () => ({ exitCode: 1, stdout: "" }),
    }),
  ).rejects.toThrow("Sign in");
  expect(
    parseEnv(await readFile(f.identityPath, "utf8")).OPENBOT_INSTALLATION_ID,
  ).toBe(installationId);
  await expect(
    setupComposio({
      ...f.options,
      environment: { OPENBOT_INSTALLATION_ID: crypto.randomUUID() },
      runCli: f.provision,
    }),
  ).rejects.toThrow("does not match");
  expect(f.calls).toEqual([]);
});

test.each(["not-a-uuid", ""])(
  "does not silently replace a corrupt saved identity (%s)",
  async (id) => {
    const f = await fixture();
    await writeFile(f.identityPath, `OPENBOT_INSTALLATION_ID=${id}\n`);
    await expect(
      setupComposio({ ...f.options, runCli: f.provision }),
    ).rejects.toThrow("installation identity");
    expect(f.calls).toEqual([]);
  },
);

test.each([
  ["old CLI", { exitCode: 1, stdout: "unknown command secret" }],
  ["malformed output", { exitCode: 0, stdout: "secret-child-output" }],
  [
    "wrong installation",
    {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "completed",
        installation_id: "wrong",
        project_id: "project",
        environment_file_written: true,
        reused: false,
      }),
    },
  ],
  [
    "key printed in metadata",
    {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "completed",
        installation_id: installationId,
        project_id: "project",
        environment_file_written: true,
        reused: false,
        api_key: "secret",
      }),
    },
  ],
] as const)(
  "rejects %s with actionable sanitized output",
  async (_, response) => {
    const f = await fixture(`OPENBOT_INSTALLATION_ID=${installationId}\n`);
    const operation = setupComposio({
      ...f.options,
      runCli: async () => response,
    });
    await expect(operation).rejects.toThrow("Sign in");
    await expect(operation).rejects.not.toThrow("secret");
    expect(
      parseEnv(await readFile(f.envPath, "utf8")).COMPOSIO_API_KEY,
    ).toBeUndefined();
  },
);

test("success metadata without a written key is a setup failure", async () => {
  const f = await fixture(`OPENBOT_INSTALLATION_ID=${installationId}\n`);
  await expect(
    setupComposio({
      ...f.options,
      runCli: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          type: "completed",
          installation_id: installationId,
          project_id: "project",
          environment_file_written: true,
          reused: true,
        }),
      }),
    }),
  ).rejects.toThrow("did not write");
});

test("a concurrently supplied key uses the CLI's already-configured response", async () => {
  const f = await fixture();
  const runCli: RunCli = async (args) => {
    await writeFile(f.envPath, "COMPOSIO_API_KEY=concurrent-operator-key\n");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "already_configured",
        installation_id: args[4],
        environment_file_written: false,
      }),
    };
  };
  expect(await setupComposio({ ...f.options, runCli })).toBe("preserved");
});

test.if(process.platform !== "win32")(
  "the real setup entry point uses the sanitized subprocess and prints no project key",
  async () => {
    const f = await fixture();
    const executable = join(f.directory, "npx");
    await writeFile(
      executable,
      `#!/usr/bin/env -S bun --no-env-file
import { readFile, writeFile } from "node:fs/promises";
if (process.env.OPENAI_API_KEY || process.env.COMPOSIO_API_KEY) process.exit(3);
const args = process.argv.slice(2);
const id = args[args.indexOf("--installation-id") + 1];
const path = args[args.indexOf("--env-path") + 1];
await writeFile(path, (await readFile(path, "utf8")) + "\\nCOMPOSIO_API_KEY=${key}\\n", {mode: 0o600});
console.log(JSON.stringify({type: "completed", installation_id: id, project_id: "project-synthetic", environment_file_written: true, reused: false}));
console.error("secret-child-stderr");
`,
    );
    await chmod(executable, 0o755);
    const child = Bun.spawn(
      [process.execPath, resolve("scripts/setup-composio.ts")],
      {
        cwd: f.directory,
        env: {
          PATH: `${f.directory}:${process.env.PATH}`,
          OPENAI_API_KEY: "secret-model-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("Composio: project key configured");
    expect(stdout).not.toContain(key);
    expect(stdout).not.toContain("secret");
  },
);
