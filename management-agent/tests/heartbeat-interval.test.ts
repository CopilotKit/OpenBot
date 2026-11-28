/**
 * The heartbeat interval, from the config.json the `openbot-agent` chart renders: a minute when the
 * config does not name one, the config's own interval when it does, and the agent's loop ticking at
 * that interval.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementAgent } from "../src/agent";
import type { ManagementClient } from "../src/client";
import { heartbeatIntervalMs, loadAgent, type ReadyAgent } from "../src/config";
import type { Kube } from "../src/kube";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

/** A config directory as the chart mounts it, with `extra` merged into config.json. */
function configDirectory(extra: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "openbot-agent-config-"));
  directories.push(directory);
  const config = {
    managementUrl: "https://management.example.test",
    installId: "0b7f4f2e-3a49-4f61-9d2c-6c1d5a7e8f90",
    cloud: "other",
    commandPublicKey: Buffer.alloc(32, 7).toString("base64"),
    window: { weekday: 0, startUtc: "00:00", hours: 168 },
    agentNamespace: "openbot-system",
    product: {
      chart: "bundle",
      releaseName: "openbot",
      namespace: "openbot",
      helmRelease: "openbot",
      ociRepository: "openbot",
      pinsConfigMap: "openbot-agent-pins",
      source: {
        url: "oci://registry.example.test/charts/openbot-bundle",
        digest: null,
        insecure: false,
        pullSecret: null,
        verify: null,
      },
      release: {
        serviceAccountName: "openbot-deployer",
        timeout: "20m",
        valuesFrom: [],
      },
    },
    backup: { kind: "none", timeoutSeconds: 900 },
    stateConfigMap: "openbot-agent-state",
    supportBundle: { pvc: "openbot-support-bundles" },
    ...extra,
  };
  writeFileSync(join(directory, "config.json"), JSON.stringify(config));
  writeFileSync(join(directory, "backup-job.yaml"), "kind: Job\n");
  writeFileSync(join(directory, "support-bundle-job.yaml"), "kind: Job\n");
  writeFileSync(join(directory, "tls.crt"), "certificate");
  writeFileSync(join(directory, "tls.key"), "key");
  return directory;
}

const load = (extra: Record<string, unknown>) => {
  const directory = configDirectory(extra);
  return loadAgent(directory, directory);
};

describe("heartbeat interval", () => {
  test("a minute when the config names none", () => {
    expect(heartbeatIntervalMs(load({}).config)).toBe(60_000);
  });

  test("the config's own interval when it names one", () => {
    expect(
      heartbeatIntervalMs(load({ heartbeatIntervalSeconds: 5 }).config),
    ).toBe(5_000);
  });

  test("refuses an interval that is not a whole number of seconds from 1 to 3600", () => {
    for (const heartbeatIntervalSeconds of [0, -5, 1.5, 3601, "5"])
      expect(() => load({ heartbeatIntervalSeconds })).toThrow();
  });

  test("the agent's loop ticks at the configured interval", async () => {
    const agent = load({ heartbeatIntervalSeconds: 1 }) as ReadyAgent;
    const management = new ManagementAgent(
      agent,
      {} as Kube,
      {} as ManagementClient,
      () => {},
    );
    const ticks: number[] = [];
    management.tick = async () => {
      ticks.push(Date.now());
    };
    const controller = new AbortController();
    const looping = management.loop(controller.signal);
    // Ticks at 0, 1 to 1.1 and 2 to 2.2 seconds; with the default minute only the first.
    const deadline = Date.now() + 10_000;
    while (ticks.length < 3 && Date.now() < deadline) await Bun.sleep(50);
    controller.abort();
    await looping;
    expect(ticks).toHaveLength(3);
    const gaps = ticks.slice(1).map((at, index) => at - (ticks[index] ?? 0));
    for (const gap of gaps) {
      // A few milliseconds of slack for the timer against the wall clock.
      expect(gap).toBeGreaterThanOrEqual(990);
      expect(gap).toBeLessThan(5_000);
    }
  });

  test("a failed heartbeat calls the agent's check, so a revoked install can enroll again without a restart", async () => {
    const agent = load({ heartbeatIntervalSeconds: 1 }) as ReadyAgent;
    const management = new ManagementAgent(
      agent,
      {} as Kube,
      {} as ManagementClient,
      () => {},
    );
    management.tick = async () => {
      throw new Error("ECONNRESET");
    };
    const failures: unknown[] = [];
    management.onHeartbeatFailure = async (error) => {
      failures.push(error);
    };
    const controller = new AbortController();
    const looping = management.loop(controller.signal);
    const deadline = Date.now() + 5_000;
    while (failures.length < 1 && Date.now() < deadline) await Bun.sleep(50);
    controller.abort();
    await looping;
    expect(String(failures[0])).toContain("ECONNRESET");
  });
});
