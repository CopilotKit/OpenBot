/**
 * Real HTTP validation of the production native emitter and the installed runtime.
 * Build the native example separately, then run:
 * bun --no-env-file --no-install desktop/scripts/validate-telemetry.ts /absolute/path/to/telemetry_probe
 * No credentials, containers, model calls, or production telemetry endpoints are used.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopTelemetryProperties } from "../../server/src/desktop-telemetry";

const root = resolve(import.meta.dir, "../..");
const fromServer = createRequire(join(root, "server/package.json"));
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Env = Record<string, string>;
type Captured = { identity: string | null; body: Record<string, unknown> };
type Queued = { event_id: string; event_name: string; occurred_at_ms: number };
type State = {
  install_id: string;
  queue: Queued[];
  activated: boolean;
  last_step: string | null;
};

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function lastObject(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line, "child did not return a JSON report");
  return object(JSON.parse(line));
}

function loopback(value: string): URL {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  return url;
}

/** Fresh process: the SDK snapshots opt-out and sampling before any runtime import. */
async function runtimeChild(endpoint: string) {
  loopback(endpoint);
  assert.equal(process.env.COPILOTKIT_TELEMETRY_URL, endpoint);
  const fetchHttp = globalThis.fetch;
  const sends: Promise<Response>[] = [];
  const blocked: string[] = [];
  const guardedFetch: typeof fetch = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        blocked.push(url.origin);
        return Promise.reject(new Error("Validation forbids external fetches"));
      }
      const result = fetchHttp(input, init);
      if (url.href === endpoint) sends.push(result);
      return result;
    },
    { preconnect: fetchHttp.preconnect },
  );
  globalThis.fetch = guardedFetch;

  const runtimePackage = fromServer("@copilotkit/runtime/package.json");
  assert.equal(
    runtimePackage.version,
    "1.70.1",
    "recheck the wire contract before changing the installed version",
  );
  // Match production-entry.ts's preload and the server's public ESM imports. Requiring the
  // CJS runtime selects a different dependency graph and does not validate the shipped path.
  await import(Bun.resolveSync("eventsource", join(root, "server")));
  const { CopilotRuntime } = await import(
    Bun.resolveSync("@copilotkit/runtime/v2", join(root, "server"))
  );
  const { createCopilotHonoHandler } = await import(
    Bun.resolveSync("@copilotkit/runtime/v2/hono", join(root, "server"))
  );
  const runtime = new CopilotRuntime({
    agents: {},
    telemetryProperties: desktopTelemetryProperties(),
  });
  const handler = createCopilotHonoHandler({
    runtime,
    basePath: "/api/copilotkit",
  });
  const info = await handler.fetch(
    new Request("http://127.0.0.1/api/copilotkit/info"),
  );
  assert.equal(info.status, 200);
  await info.text();
  // Handler creation queues instance_created in a promise continuation. Drain it before
  // waiting on the real fetches; no transport is mocked and no polling timeout proves success.
  await new Promise<void>((done) => setImmediate(done));
  await Promise.all(sends);
  assert.deepEqual(blocked, []);
  console.log(
    JSON.stringify({
      runtimeVersion: runtimePackage.version,
      requests: sends.length,
    }),
  );
}

async function validate(nativePath: string) {
  assert.ok(
    existsSync(nativePath),
    `Build the native telemetry_probe example first: ${nativePath}`,
  );
  const scratch = await mkdtemp(
    join(tmpdir(), "openbot-telemetry-validation-"),
  );
  const received: Captured[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert.equal(request.method, "POST");
      assert.equal(new URL(request.url).pathname, "/ingest");
      const raw = await request.text();
      assert.ok(Buffer.byteLength(raw) <= 16 * 1024);
      received.push({
        identity: request.headers.get("X-CopilotKit-Telemetry-Id"),
        body: object(JSON.parse(raw)),
      });
      return Response.json({ ok: true }, { status: 202 });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}/ingest`;
  // Reserve and close a second local socket: a real connection-refused flush, not a fake transport.
  const offline = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const offlineEndpoint = `http://127.0.0.1:${offline.port}/ingest`;
  await offline.stop(true);

  const cleanEnv: Env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    NO_COLOR: "1",
  };
  // NODE_PATH is an explicit caller-selected resolution aid for existing installations;
  // this script never installs packages or silently rewires their dependency graph.
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "NODE_PATH"]) {
    const value = process.env[key];
    if (value) cleanEnv[key] = value;
  }
  async function processRun(command: string[], env: Env, cwd = scratch) {
    const child = Bun.spawn(command, {
      cwd,
      env: { ...cleanEnv, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timeout);
    }
  }
  function lastJson(stdout: string): Env {
    const parsed = lastObject(stdout);
    assert.ok(
      Object.values(parsed).every((value) => typeof value === "string"),
    );
    return parsed as Env;
  }
  async function native(
    directory: string,
    action: string,
    env: Env = {},
    url = endpoint,
  ) {
    const result = await processRun([nativePath, directory, url, action], env);
    assert.equal(
      result.code,
      0,
      `${action} failed: ${result.stderr.slice(0, 500)}`,
    );
    return lastJson(result.stdout);
  }
  async function state(directory: string): Promise<State> {
    return JSON.parse(
      await readFile(join(directory, "telemetry-state.json"), "utf8"),
    );
  }
  async function runtime(env: Env) {
    const result = await processRun(
      [
        process.execPath,
        "--no-env-file",
        "--no-install",
        import.meta.path,
        "--runtime-child",
        endpoint,
      ],
      { ...env, COPILOTKIT_TELEMETRY_URL: endpoint },
      join(root, "server"),
    );
    assert.equal(
      result.code,
      0,
      `runtime child failed: ${result.stderr.slice(0, 1000)}`,
    );
    return lastObject(result.stdout);
  }
  const checks: string[] = [];
  try {
    const recoveredDir = join(scratch, "recovered");
    const nativeEnv = await native(recoveredDir, "record", {}, offlineEndpoint);
    const original = await state(recoveredDir);
    assert.match(original.install_id, uuid);
    assert.equal(original.queue.length, 1);
    assert.equal(original.queue[0].event_name, "oss.desktop.step_viewed");
    assert.equal(nativeEnv.CPK_TELEMETRY_ID, original.install_id);
    assert.equal(nativeEnv.COPILOTKIT_TELEMETRY_SAMPLE_RATE, "1");
    const failed = await processRun(
      [nativePath, recoveredDir, offlineEndpoint, "flush"],
      {},
    );
    assert.notEqual(failed.code, 0, "offline connection must fail");
    const queued = await state(recoveredDir);
    assert.equal(queued.install_id, original.install_id);
    assert.equal(queued.queue.length, 2);
    assert.equal(queued.queue[0].event_id, original.queue[0].event_id);
    assert.equal(queued.queue[1].event_name, "oss.desktop.setup_abandoned");
    assert.equal(received.length, 0);
    const relaunchedEnv = await native(recoveredDir, "flush");
    assert.deepEqual(relaunchedEnv, nativeEnv);
    assert.deepEqual(
      received.map((request) => request.body.event_id),
      queued.queue.map((event) => event.event_id),
    );
    assert.ok(
      received.every((request) => request.identity === original.install_id),
    );
    assert.deepEqual(
      received.map((request) => request.body.ts),
      queued.queue.map((event) => Math.floor(event.occurred_at_ms / 1000)),
    );
    assert.equal((await state(recoveredDir)).queue.length, 0);
    await native(recoveredDir, "flush");
    assert.equal(
      received.length,
      2,
      "successful flush must not replay acknowledged events",
    );
    checks.push(
      "offline queue replay: stable installation and event IDs; one recovered abandonment",
    );

    const quitStart = received.length;
    await native(join(scratch, "quit"), "quit");
    assert.deepEqual(
      received.slice(quitStart).map((request) => request.body.event),
      ["oss.desktop.step_viewed", "oss.desktop.setup_abandoned"],
    );
    checks.push("quit flushes current step and abandonment");

    const activationStart = received.length;
    const activatedDir = join(scratch, "activated");
    await native(activatedDir, "activate");
    await native(activatedDir, "activate");
    assert.deepEqual(
      received.slice(activationStart).map((request) => request.body.event),
      ["oss.desktop.activated"],
    );
    assert.equal((await state(activatedDir)).activated, true);
    checks.push(
      "activation emitted once across duplicate calls and process relaunch",
    );

    const nativeRequests = received.length;
    for (const request of received) {
      assert.deepEqual(Object.keys(request.body).sort(), [
        "event",
        "event_id",
        "global_properties",
        "package",
        "properties",
        "ts",
      ]);
      assert.match(String(request.body.event_id), uuid);
      assert.deepEqual(request.body.package, {
        name: "openbot-desktop",
        version: "0.0.9",
      });
      assert.deepEqual(object(request.body.global_properties), {
        ...desktopTelemetryProperties(nativeEnv),
        runtime_env: "test",
        sampleRate: 1,
        sampleWeight: 1,
        sampleRateAdjustmentFactor: 0,
      });
    }
    checks.push(
      "native wire envelope uses closed metadata, seconds and full sampling",
    );

    const runtimeResult = await runtime({
      ...nativeEnv,
      OPENBOT_UNKNOWN: "synthetic-private-value",
    });
    assert.equal(runtimeResult.requests, 1);
    const runtimeRequest = received.at(-1);
    assert.ok(runtimeRequest);
    assert.equal(received.length, nativeRequests + 1);
    assert.equal(runtimeRequest.identity, original.install_id);
    assert.equal(runtimeRequest.body.event, "oss.runtime.instance_created");
    assert.deepEqual(runtimeRequest.body.package, {
      name: "@copilotkit/runtime",
      version: "1.70.1",
    });
    assert.deepEqual(runtimeRequest.body.properties, {
      actionsAmount: 0,
      endpointTypes: [],
      endpointsAmount: 0,
      agentsAmount: 0,
      "cloud.api_key_provided": false,
    });
    assert.deepEqual(runtimeRequest.body.global_properties, {
      ...desktopTelemetryProperties(nativeEnv),
      sampleRate: 1,
      sampleWeight: 1,
      sampleRateAdjustmentFactor: 0,
      telemetry_identified: false,
      telemetry_emitter: "v2-runtime",
      telemetry_transport: "lambda",
    });
    assert.ok(
      Number(runtimeRequest.body.ts) > 1_000_000_000 &&
        Number(runtimeRequest.body.ts) < 10_000_000_000,
    );
    checks.push(
      "installed runtime1.70.1 Hono boot event: same native UUID, closed metadata, full sampling",
    );

    for (const variable of ["COPILOTKIT_TELEMETRY_DISABLED", "DO_NOT_TRACK"]) {
      for (const value of ["true", "1"]) {
        const before: number = received.length;
        const directory = join(scratch, `${variable}-${value}`);
        await native(directory, "record", {}, offlineEndpoint);
        assert.ok((await state(directory)).queue.length > 0);
        const optedOutEnv = await native(directory, "quit", {
          [variable]: value,
        });
        assert.deepEqual(optedOutEnv, { COPILOTKIT_TELEMETRY_DISABLED: "1" });
        assert.equal(
          existsSync(join(directory, "telemetry-state.json")),
          false,
        );
        const fresh = join(scratch, `${variable}-${value}-fresh`);
        assert.deepEqual(
          await native(fresh, "env", { [variable]: value }),
          optedOutEnv,
        );
        assert.equal(existsSync(join(fresh, "telemetry-state.json")), false);
        // Test the SDK's own override too, even if a caller retained an older enabled ID.
        assert.equal(
          (await runtime({ ...nativeEnv, [variable]: value })).requests,
          0,
        );
        assert.equal(received.length, before);
        checks.push(
          `${variable}=${value}: queue purged, no identity or HTTP sends, runtime also disabled`,
        );
      }
    }
    assert.equal(
      (await runtime({ COPILOTKIT_TELEMETRY_DISABLED: "1" })).requests,
      0,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          checks,
          nativeRequests,
          runtimeRequests: 1,
          runtimeVersion: "1.70.1",
          externalRequests: 0,
        },
        null,
        2,
      ),
    );
  } finally {
    await server.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--runtime-child") {
  await runtimeChild(process.argv[3]);
} else {
  const nativePath =
    process.argv[2] ??
    join(root, "desktop/src-tauri/target/release/examples/telemetry_probe");
  await validate(resolve(nativePath));
}
