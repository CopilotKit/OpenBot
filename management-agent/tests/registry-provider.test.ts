/**
 * THE PRODUCT'S CHART FROM A MIRROR IN THE CLOUD'S OWN REGISTRY.
 *
 * ECR, ACR and Artifact Registry hand out pull tokens that last hours, so a pull secret holding one
 * stops working the same day. Flux signs in to them itself with source-controller's workload
 * identity when the OCIRepository names the cloud (`spec.provider`). The agent sets it from the
 * chart's `product.source.provider`, on a new OCIRepository and on one that exists, and takes it
 * away again when the setting goes, so the source falls back to the pull secret or to none.
 *
 * Driven as the agent runs: its config read from a directory laid out as the chart mounts it, and
 * `Flux.ensure` speaking kubectl, whose calls are recorded.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent, type ReadyAgent } from "../src/config";
import { Flux } from "../src/flux";
import { CommandFailed, Kube } from "../src/kube";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

function agentWith(source: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), "openbot-agent-provider-"));
  directories.push(directory);
  const config = {
    managementUrl: "https://management.example.test",
    installId: "0b7f4f2e-3a49-4f61-9d2c-6c1d5a7e8f90",
    cloud: "aws",
    commandPublicKey: Buffer.alloc(32, 7).toString("base64"),
    window: { weekday: 0, startUtc: "00:00", hours: 168 },
    agentNamespace: "openbot-system",
    product: {
      chart: "openbot",
      releaseName: "openbot",
      namespace: "openbot",
      helmRelease: "openbot",
      ociRepository: "openbot",
      pinsConfigMap: "openbot-agent-pins",
      source: {
        url: "oci://123456789012.dkr.ecr.us-east-2.amazonaws.com/charts/openbot",
        digest: null,
        insecure: false,
        pullSecret: null,
        verify: { provider: "cosign", secretRef: "openbot-cosign" },
        ...source,
      },
      release: {
        serviceAccountName: "openbot-deployer",
        timeout: "15m",
        valuesFrom: [],
      },
    },
    backup: { kind: "none", timeoutSeconds: 900 },
    stateConfigMap: "openbot-agent-state",
    supportBundle: { pvc: "openbot-support-bundles" },
  };
  writeFileSync(join(directory, "config.json"), JSON.stringify(config));
  writeFileSync(join(directory, "backup-job.yaml"), "kind: Job\n");
  writeFileSync(join(directory, "support-bundle-job.yaml"), "kind: Job\n");
  writeFileSync(join(directory, "tls.crt"), "certificate");
  writeFileSync(join(directory, "tls.key"), "key");
  return loadAgent(directory, directory) as ReadyAgent;
}

/** kubectl against a cluster where the two objects do (`existing`) or don't exist yet. */
function recordingKube(existing: boolean) {
  const created: Record<string, unknown>[] = [];
  const patches: { resource: string; patch: Record<string, unknown> }[] = [];
  const kube = new Kube(async (command, options = {}) => {
    const args = command.slice(1);
    if (args.includes("get")) {
      if (!existing)
        throw new CommandFailed(
          [...command],
          1,
          'Error from server (NotFound): ocirepositories.source.toolkit.fluxcd.io "openbot" not found',
        );
      return JSON.stringify({ spec: {} });
    }
    if (args.includes("create")) {
      created.push(JSON.parse(options.input ?? "{}"));
      return "";
    }
    if (args.includes("patch")) {
      const at = args.indexOf("--patch");
      patches.push({
        resource: args[args.indexOf("patch") + 1] ?? "",
        patch: JSON.parse(args[at + 1] ?? "{}"),
      });
      return "";
    }
    return "{}";
  });
  return { kube, created, patches };
}

const ociRepository = (objects: Record<string, unknown>[]) =>
  objects.find((object) => object.kind === "OCIRepository") as
    | { spec: Record<string, unknown> }
    | undefined;

describe("the product's chart from the cloud's own registry", () => {
  test("a new OCIRepository names the cloud, and Flux signs in with its own identity", async () => {
    const { kube, created } = recordingKube(false);
    await new Flux(kube, agentWith({ provider: "aws" }).config).ensure();
    const source = ociRepository(created);
    expect(source?.spec.provider).toBe("aws");
    expect(source?.spec.url).toBe(
      "oci://123456789012.dkr.ecr.us-east-2.amazonaws.com/charts/openbot",
    );
    // The signature is still checked, with the mirror's own key.
    expect(source?.spec.verify).toEqual({
      provider: "cosign",
      secretRef: { name: "openbot-cosign" },
    });
    expect(source?.spec).not.toHaveProperty("secretRef");
  });

  test("an existing OCIRepository is brought to it, and loses it when the setting goes", async () => {
    const on = recordingKube(true);
    await new Flux(on.kube, agentWith({ provider: "gcp" }).config).ensure();
    const set = on.patches.find((p) => p.resource.startsWith("ocirepositor"));
    expect(set?.patch.spec).toMatchObject({ provider: "gcp" });

    const off = recordingKube(true);
    await new Flux(
      off.kube,
      agentWith({ pullSecret: "mirror-pull" }).config,
    ).ensure();
    const cleared = off.patches.find((p) =>
      p.resource.startsWith("ocirepositor"),
    );
    // null removes the field in a merge patch: the pull secret signs in instead.
    expect(cleared?.patch.spec).toMatchObject({
      provider: null,
      secretRef: { name: "mirror-pull" },
    });
  });

  test("without the setting a new OCIRepository has no provider, as before", async () => {
    const { kube, created } = recordingKube(false);
    await new Flux(kube, agentWith({}).config).ensure();
    expect(ociRepository(created)?.spec).not.toHaveProperty("provider");
  });

  test("only a cloud Flux knows is accepted", () => {
    expect(() => agentWith({ provider: "generic" })).toThrow();
    expect(() => agentWith({ provider: "dockerhub" })).toThrow();
  });
});
