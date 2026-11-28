import { describe, expect, test } from "bun:test";
import candidateFixture from "../fixtures/releases/candidate.json";
import published from "../fixtures/releases/published-v1.1.0.json";
import {
  identityMatches,
  type KubeRunner,
  lastMigrationName,
  type PromotionJournal,
  runPromotion,
  serverDeployment,
} from "../kubernetes-promotion";
import { parseReleaseManifest } from "../release-manifest";

// What the published v1.1.0 server answers on /release, read from a running pod of
// ghcr.io/copilotkit/openbot@sha256:479cccd4... installed by the v1.1.0 openbot-bundle chart.
const served = {
  version: "v1.1.0",
  commit: "9a11f982a74aa8c65a1e6983e3977612f7abab29",
  distributionId: "CopilotKit/OpenBot",
  repository: "CopilotKit/OpenBot",
  channel: "stable",
};

describe("running release identity", () => {
  const manifest = parseReleaseManifest(structuredClone(published));

  test("a published release's server is accepted as that release, though it reports its image's build commit", () => {
    expect(manifest.source.commit).not.toBe(served.commit);
    expect(identityMatches(served, manifest)).toBe(true);
  });

  test("another version, distribution, repository or channel is refused", () => {
    expect(identityMatches({ ...served, version: "v1.0.3" }, manifest)).toBe(
      false,
    );
    expect(
      identityMatches({ ...served, distributionId: "acme.openbot" }, manifest),
    ).toBe(false);
    expect(
      identityMatches({ ...served, repository: "acme/openbot" }, manifest),
    ).toBe(false);
    expect(identityMatches({ ...served, channel: "internal" }, manifest)).toBe(
      false,
    );
  });
});

describe("last applied migration", () => {
  test("read from the object a current server reports, the name an earlier one reported, or nothing", () => {
    // A server with the internal status listener answers /release with an object.
    expect(
      lastMigrationName({
        ...served,
        lastAppliedMigration: {
          name: "0137_ai_connections",
          hash: "9f2c4e1a7b3d5f60",
          createdAt: 1763452800000,
        },
      }),
    ).toBe("0137_ai_connections");
    expect(
      lastMigrationName({
        ...served,
        lastAppliedMigration: "0132_bot_task_runs",
      }),
    ).toBe("0132_bot_task_runs");
    // v1.1.0's server, above, names none.
    expect(lastMigrationName(served)).toBeNull();
    expect(
      lastMigrationName({ ...served, lastAppliedMigration: null }),
    ).toBeNull();
    expect(lastMigrationName(null)).toBeNull();
  });
});

/**
 * A namespace with one server Deployment, as kubectl reads and changes it, on a simulated clock.
 *
 * Scaled to zero, the ReplicaSet deletes each server pod with the pod's own termination grace
 * period (the template's, or Kubernetes' 30 s default). A stopping server keeps serving, drains
 * its in-flight runs, then exits; the kubelet kills it once the grace period is over, whichever
 * comes first. `kubectl wait --for=delete --timeout=<n>s` returns once the pods are gone, or fails
 * as kubectl does when n seconds pass first. Nothing sleeps: a wait moves the clock on instead.
 */
function cluster(grace: number | undefined, drainSeconds: number) {
  const candidate = parseReleaseManifest(structuredClone(candidateFixture));
  const image = `ghcr.io/acme/openbot@sha256:${"b".repeat(64)}`;
  candidate.artifacts.images.openbot = { reference: image };
  const deployment = {
    metadata: { name: "openbot-server" },
    spec: {
      replicas: 2,
      template: {
        metadata: {
          annotations: {
            "openbot.ai/distribution": candidate.distribution.id,
            "openbot.ai/release": "v0.2.0",
            "openbot.ai/source-commit": "2".repeat(40),
          },
        },
        spec: {
          ...(grace === undefined
            ? {}
            : { terminationGracePeriodSeconds: grace }),
          containers: [
            {
              name: "server",
              image: `ghcr.io/acme/openbot:v0.2.0@sha256:${"a".repeat(64)}`,
            },
          ],
        },
      },
    },
  };
  const state = {
    now: 0,
    /** When the last server pod is gone, once the server has been scaled to zero. */
    podsGoneAt: null as number | null,
    deleteWaits: [] as string[][],
  };
  const run: KubeRunner = async (command) => {
    const verb = command[3];
    const argument = (prefix: string) =>
      command.find((part) => part.startsWith(prefix))?.slice(prefix.length);
    if (verb === "get" && command[4] === "cronjob")
      return JSON.stringify({ items: [] });
    if (verb === "get" && command[4] === "deployment")
      return JSON.stringify({ items: [deployment] });
    if (verb === "scale") {
      deployment.spec.replicas = Number(argument("--replicas="));
      if (deployment.spec.replicas === 0 && state.podsGoneAt === null)
        state.podsGoneAt = state.now + Math.min(drainSeconds, grace ?? 30);
      return "";
    }
    if (verb === "wait" && command.includes("--for=delete")) {
      state.deleteWaits.push([...command]);
      const timeout = Number(argument("--timeout=")?.replace(/s$/, ""));
      const gone = state.podsGoneAt ?? state.now;
      if (gone - state.now > timeout) {
        state.now += timeout;
        throw new Error(
          "kubectl --namespace customer wait failed (1): error: timed out waiting for the condition on pods/openbot-server-7c9d8b6f4-x2kqp",
        );
      }
      state.now = Math.max(state.now, gone);
      return "";
    }
    if (verb === "rollout") return "";
    if (verb === "exec")
      return JSON.stringify({
        version: candidate.version,
        distributionId: candidate.distribution.id,
        repository: candidate.distribution.repository,
        channel: candidate.distribution.channel,
      });
    throw new Error(`unexpected command: ${command.join(" ")}`);
  };
  /** What the chart does once the candidate is pinned: the server runs the candidate's image with
   * its identity. */
  const apply = async () => {
    deployment.spec.template.metadata.annotations = {
      "openbot.ai/distribution": candidate.distribution.id,
      "openbot.ai/release": candidate.version,
      "openbot.ai/source-commit": candidate.source.commit,
    };
    deployment.spec.template.spec.containers = [{ name: "server", image }];
  };
  return { candidate, run, apply, state };
}

/** A promotion that stops writes first, as the management agent runs it: 900 s as its timeout. */
async function promoteWithMaintenance(f: ReturnType<typeof cluster>) {
  const target = {
    namespace: "customer",
    release: "openbot",
    cwd: "/tmp",
    timeoutSeconds: 900,
  };
  const journal: PromotionJournal = {
    operation: "test",
    phase: "prepared",
    fromVersion: "v0.2.0",
    toVersion: f.candidate.version,
    namespace: target.namespace,
    release: target.release,
    backupReference: "none",
    databaseMayHaveChanged: false,
    recovery: "restore a backup",
  };
  const phases: string[] = [];
  let backedUpAt: number | null = null;
  const result = runPromotion({
    target,
    run: f.run,
    candidate: f.candidate,
    journal,
    save: (entry) => {
      phases.push(entry.phase);
    },
    before: await serverDeployment(target, f.run),
    maintenance: true,
    backup: async () => {
      backedUpAt = f.state.now;
    },
    apply: f.apply,
    declaredSuspension: async () => new Set(),
  });
  return {
    result,
    phases,
    backedUpAt: () => backedUpAt,
  };
}

describe("quiescing the server before a backup", () => {
  test("waits out a server pod that is still draining a run for a grace period far above the promotion timeout", async () => {
    // 30 s of serving on, a run that drains for the full 1800 s, and 15 s to spare.
    const f = cluster(1845, 30 + 1800);
    const promotion = await promoteWithMaintenance(f);
    expect((await promotion.result).phase).toBe("accepted");
    expect(promotion.phases).not.toContain("failed");
    // The backup ran only once the drain had finished and the pods were gone.
    expect(promotion.backedUpAt()).toBe(1830);
    const wait = f.state.deleteWaits[0] ?? [];
    const timeout = Number(
      wait.find((part) => part.startsWith("--timeout="))?.slice(10, -1),
    );
    expect(timeout).toBeGreaterThanOrEqual(1845);
  });

  test("keeps the promotion timeout as the least it waits for a server with the default grace period", async () => {
    const f = cluster(undefined, 30);
    const promotion = await promoteWithMaintenance(f);
    expect((await promotion.result).phase).toBe("accepted");
    expect(f.state.deleteWaits[0]).toContain("--timeout=900s");
  });
});
