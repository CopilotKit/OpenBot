import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxState } from "@daytona/sdk";
import { createDaytonaComputerProvider } from "../src/computer/daytona";
import {
  describeComputerIsolation,
  ProviderError,
} from "../src/computer/provider";
import type { ComputerStatus } from "../src/computer/schema";
import {
  createFakeSdk,
  fakeFetch,
  makeClient,
  makeSandbox,
} from "./computer-daytona-fixture";

describe("Daytona computer supervisor", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    }
    tempDirs.length = 0;
  });

  test("exposes the Daytona per-Bot provider contract", () => {
    const provider = createDaytonaComputerProvider({
      apiKey: "test-api-key",
      computerToken: "tok",
      snapshot: "prebuilt",
      sdk: createFakeSdk(),
      fetchImpl: fakeFetch(),
    });

    expect(provider.name).toBe("Daytona");
    expect(provider.isolation).toBe("per-bot");
    expect(describeComputerIsolation(provider).isolation).toBe(
      "one computer per Bot",
    );
  });

  test("status maps Daytona lifecycle states without starting or creating a sandbox", async () => {
    const cases: Array<{
      botId: string;
      state: SandboxState;
      expected: ComputerStatus;
    }> = [
      {
        botId: "bot-started",
        state: SandboxState.STARTED,
        expected: { botId: "bot-started", state: "ready" },
      },
      {
        botId: "bot-starting",
        state: SandboxState.STARTING,
        expected: { botId: "bot-starting", state: "starting" },
      },
      {
        botId: "bot-creating",
        state: SandboxState.CREATING,
        expected: { botId: "bot-creating", state: "starting" },
      },
      {
        botId: "bot-restoring",
        state: SandboxState.RESTORING,
        expected: { botId: "bot-restoring", state: "starting" },
      },
      {
        botId: "bot-pulling",
        state: SandboxState.PULLING_SNAPSHOT,
        expected: { botId: "bot-pulling", state: "starting" },
      },
      {
        botId: "bot-resuming",
        state: SandboxState.RESUMING,
        expected: { botId: "bot-resuming", state: "starting" },
      },
      {
        botId: "bot-pending-build",
        state: SandboxState.PENDING_BUILD,
        expected: { botId: "bot-pending-build", state: "starting" },
      },
      {
        botId: "bot-building-snapshot",
        state: SandboxState.BUILDING_SNAPSHOT,
        expected: { botId: "bot-building-snapshot", state: "starting" },
      },
      {
        botId: "bot-resizing",
        state: SandboxState.RESIZING,
        expected: { botId: "bot-resizing", state: "starting" },
      },
      {
        botId: "bot-snapshotting",
        state: SandboxState.SNAPSHOTTING,
        expected: { botId: "bot-snapshotting", state: "starting" },
      },
      {
        botId: "bot-forking",
        state: SandboxState.FORKING,
        expected: { botId: "bot-forking", state: "starting" },
      },
      {
        botId: "bot-stopped",
        state: SandboxState.STOPPED,
        expected: { botId: "bot-stopped", state: "absent" },
      },
      {
        botId: "bot-paused",
        state: SandboxState.PAUSED,
        expected: { botId: "bot-paused", state: "absent" },
      },
      {
        botId: "bot-archived",
        state: SandboxState.ARCHIVED,
        expected: { botId: "bot-archived", state: "absent" },
      },
      {
        botId: "bot-destroyed",
        state: SandboxState.DESTROYED,
        expected: { botId: "bot-destroyed", state: "absent" },
      },
      {
        botId: "bot-destroying",
        state: SandboxState.DESTROYING,
        expected: { botId: "bot-destroying", state: "absent" },
      },
      {
        botId: "bot-archiving",
        state: SandboxState.ARCHIVING,
        expected: { botId: "bot-archiving", state: "absent" },
      },
      {
        botId: "bot-pausing",
        state: SandboxState.PAUSING,
        expected: { botId: "bot-pausing", state: "absent" },
      },
      {
        botId: "bot-stopping",
        state: SandboxState.STOPPING,
        expected: { botId: "bot-stopping", state: "absent" },
      },
      {
        botId: "bot-error",
        state: SandboxState.ERROR,
        expected: {
          botId: "bot-error",
          state: "unreachable",
          reason: 'Daytona reported the computer state "error".',
        },
      },
      {
        botId: "bot-build-failed",
        state: SandboxState.BUILD_FAILED,
        expected: {
          botId: "bot-build-failed",
          state: "unreachable",
          reason: 'Daytona reported the computer state "build_failed".',
        },
      },
      {
        botId: "bot-unknown",
        state: SandboxState.UNKNOWN,
        expected: {
          botId: "bot-unknown",
          state: "unreachable",
          reason: 'Daytona reported the computer state "unknown".',
        },
      },
      {
        botId: "bot-unknown-default-open-api",
        state: SandboxState.UNKNOWN_DEFAULT_OPEN_API,
        expected: {
          botId: "bot-unknown-default-open-api",
          state: "unreachable",
          reason: 'Daytona reported the computer state "11184809".',
        },
      },
    ];

    const sandboxes = cases.map((c, index) =>
      makeSandbox({ id: `status-${index}`, botId: c.botId, state: c.state }),
    );
    const sdk = createFakeSdk(sandboxes);
    const provider = makeClient(sdk);

    for (const c of cases) {
      const status = await provider.status(c.botId);
      expect(status).toEqual(c.expected);
    }
    expect(sdk.creates).toHaveLength(0);
    expect(sandboxes.every((sandbox) => sandbox.startCalls === 0)).toBe(true);
  });

  test("status reports an unknown Bot as absent without preparing the snapshot", async () => {
    const sdk = createFakeSdk();
    sdk.snapshot.get = async () => {
      throw new Error("status must not inspect the snapshot");
    };
    const provider = createDaytonaComputerProvider({
      apiKey: "test-api-key",
      computerToken: "tok",
      sdk,
      fetchImpl: fakeFetch(),
    });

    await expect(provider.status("missing-bot")).resolves.toEqual({
      botId: "missing-bot",
      state: "absent",
    });
    expect(sdk.creates).toHaveLength(0);
  });

  test("SDK failure throws ProviderError naming the Bot", async () => {
    const sdk = createFakeSdk();
    sdk.create = async () => {
      throw new Error("quota exceeded");
    };

    const client = makeClient(sdk);

    await expect(client.locate("analytics")).rejects.toThrow(ProviderError);
    await expect(client.locate("analytics")).rejects.toThrow(/analytics/);
  });

  test("health timeout throws ProviderError", async () => {
    const sdk = createFakeSdk();
    const failingFetch = fakeFetch(
      () => new Response("service unavailable", { status: 503 }),
    );

    const client = makeClient(sdk, {
      healthTimeoutMs: 50,
      fetchImpl: failingFetch,
    });

    await expect(client.locate("unhealthy-bot")).rejects.toThrow(ProviderError);
    await expect(client.locate("unhealthy-bot")).rejects.toThrow(
      /The computer for unhealthy-bot started but never answered \/health/,
    );
  });

  test("health fetch that never resolves is bounded by healthTimeoutMs and locate rejects with ProviderError", async () => {
    const sdk = createFakeSdk();
    const hangingFetch = fakeFetch(() => {
      const { promise } = Promise.withResolvers<Response>();
      return promise;
    });

    const client = makeClient(sdk, {
      healthTimeoutMs: 30,
      fetchImpl: hangingFetch,
    });

    let locateError: unknown;
    try {
      await client.locate("hanging-health-bot");
    } catch (err) {
      locateError = err;
    }

    expect(locateError).toBeInstanceOf(ProviderError);
    expect((locateError as Error)?.message).toContain(
      "The computer for hanging-health-bot started but never answered /health at its preview URL.",
    );
  });

  test("snapshot.create that never resolves is bounded by snapshotTimeoutMs and locate rejects with ProviderError", async () => {
    const fixtureDir = mkdtempSync(
      join(tmpdir(), "openbot-agent-computer-test-"),
    );
    tempDirs.push(fixtureDir);

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "agent-computer", version: "1.0.0" }),
    );
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("agent-computer");\n',
    );

    const sdk = createFakeSdk();
    sdk.snapshot.create = () => {
      const { promise } = Promise.withResolvers<unknown>();
      return promise;
    };

    const client = makeClient(sdk, {
      agentComputerDir: fixtureDir,
      snapshotTimeoutMs: 30,
    });

    let locateError: unknown;
    try {
      await client.locate("hanging-snapshot-bot");
    } catch (err) {
      locateError = err;
    }

    expect(locateError).toBeInstanceOf(ProviderError);
  });

  test("missing agentComputerDir package.json or src directory rejects locate with ProviderError naming the directory and advising DAYTONA_SNAPSHOT", async () => {
    const missingPkgDir = mkdtempSync(
      join(tmpdir(), "openbot-missing-pkg-test-"),
    );
    tempDirs.push(missingPkgDir);
    mkdirSync(join(missingPkgDir, "src"), { recursive: true });
    writeFileSync(
      join(missingPkgDir, "src", "index.ts"),
      'console.log("agent-computer");\n',
    );

    const clientMissingPkg = makeClient(createFakeSdk(), {
      agentComputerDir: missingPkgDir,
      healthTimeoutMs: 50,
    });

    let pkgError: unknown;
    try {
      await clientMissingPkg.locate("missing-pkg-bot");
    } catch (err) {
      pkgError = err;
    }

    expect(pkgError).toBeInstanceOf(ProviderError);
    expect((pkgError as Error)?.message).toContain(missingPkgDir);
    expect((pkgError as Error)?.message).toContain("DAYTONA_SNAPSHOT");

    const missingSrcDir = mkdtempSync(
      join(tmpdir(), "openbot-missing-src-test-"),
    );
    tempDirs.push(missingSrcDir);
    writeFileSync(
      join(missingSrcDir, "package.json"),
      JSON.stringify({ name: "agent-computer", version: "1.0.0" }),
    );

    const clientMissingSrc = makeClient(createFakeSdk(), {
      agentComputerDir: missingSrcDir,
      healthTimeoutMs: 50,
    });

    let srcError: unknown;
    try {
      await clientMissingSrc.locate("missing-src-bot");
    } catch (err) {
      srcError = err;
    }

    expect(srcError).toBeInstanceOf(ProviderError);
    expect((srcError as Error)?.message).toContain(missingSrcDir);
    expect((srcError as Error)?.message).toContain("DAYTONA_SNAPSHOT");
  });

  test("snapshot naming is stable for unchanged temp sources and changes when source contents change", async () => {
    const fixtureDir = mkdtempSync(
      join(tmpdir(), "openbot-agent-computer-test-"),
    );
    tempDirs.push(fixtureDir);

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "agent-computer", version: "1.0.0" }),
    );
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("hello world");\n',
    );

    const sdk1 = createFakeSdk();
    const client1 = makeClient(sdk1, { agentComputerDir: fixtureDir });

    await client1.locate("bot-1");
    expect(sdk1.creates).toHaveLength(1);
    const snapshotName1 = sdk1.creates[0].snapshot;
    expect(snapshotName1).toMatch(/^openbot-agent-computer-[a-f0-9]{12}$/);

    const sdk2 = createFakeSdk();
    const client2 = makeClient(sdk2, { agentComputerDir: fixtureDir });

    await client2.locate("bot-2");
    expect(sdk2.creates).toHaveLength(1);
    const snapshotName2 = sdk2.creates[0].snapshot;
    expect(snapshotName2).toBe(snapshotName1);

    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("hello world updated");\n',
    );

    const sdk3 = createFakeSdk();
    const client3 = makeClient(sdk3, { agentComputerDir: fixtureDir });

    await client3.locate("bot-3");
    expect(sdk3.creates).toHaveLength(1);
    const snapshotName3 = sdk3.creates[0].snapshot;
    expect(snapshotName3).toMatch(/^openbot-agent-computer-[a-f0-9]{12}$/);
    expect(snapshotName3).not.toBe(snapshotName1);
  });

  test("snapshot image recipe configures PATH with bun and standard system binaries without literal variable substitution", async () => {
    const fixtureDir = mkdtempSync(
      join(tmpdir(), "openbot-agent-computer-test-"),
    );
    tempDirs.push(fixtureDir);

    writeFileSync(
      join(fixtureDir, "package.json"),
      JSON.stringify({ name: "agent-computer", version: "1.0.0" }),
    );
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "src", "index.ts"),
      'console.log("hello world");\n',
    );

    let capturedImage: { dockerfile: string } | undefined;
    const sdk = createFakeSdk();
    const originalSnapshotCreate = sdk.snapshot.create;
    sdk.snapshot.create = async (params, options) => {
      capturedImage = params.image as { dockerfile: string };
      return originalSnapshotCreate(params, options);
    };

    const client = makeClient(sdk, { agentComputerDir: fixtureDir });

    await client.locate("recipe-test-bot");

    expect(capturedImage).toBeDefined();
    if (!capturedImage) {
      throw new Error("capturedImage must be defined");
    }
    const dockerfile = capturedImage.dockerfile;

    const envPathLine = dockerfile
      .split("\n")
      .find((line) => line.startsWith("ENV PATH="));

    expect(envPathLine).toBeDefined();
    expect(envPathLine).toContain("/root/.bun/bin");
    expect(envPathLine).toContain("/usr/bin");
    expect(envPathLine).toContain("/bin");
    const dollarPath = "$" + "{PATH}";
    expect(envPathLine).not.toContain(dollarPath);
    expect(dockerfile).not.toContain(dollarPath);
  });
});
