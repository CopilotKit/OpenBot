/**
 * The OpenBot management agent: installed only when an install's owner chooses management, it
 * sends a heartbeat every minute, moves the product to the version CopilotKit's management service
 * asks for (by pinning Flux to that release's exact chart digest, inside the maintenance window,
 * only along the release policy's upgrade paths, with a verified backup first whenever the
 * database changes), and runs the few signed commands it knows.
 *
 * It never rolls back by itself. A promotion that stops after the database may have changed ends
 * in `recovery-required`, which blocks every further upgrade until a person clears it.
 */
import {
  identityMatches,
  imageParts,
  needsMaintenance,
  type PromotionJournal,
  promotionValues,
  type ReleaseIdentity,
  runPromotion,
  selectedImage,
  serverDeployment,
  verifyDeployment,
} from "../../shared/kubernetes-promotion";
import {
  type Command,
  type CommandResult,
  type DesiredState,
  HEARTBEAT_INTERVAL_SECONDS,
  type HeartbeatReply,
  type MaintenanceWindow,
  ROLLBACK_REFUSED_REASON,
  readCommands,
  releaseManifestDigest,
  type UpgradeState,
} from "../../shared/management-contract";
import {
  parseReleaseManifest,
  planUpgrade,
  type ReleaseManifest,
} from "../../shared/release-manifest";
import type { ManagementClient } from "./client";
import type { Agent } from "./config";
import { Flux } from "./flux";
import { operationId, runJob } from "./jobs";
import { CommandFailed, type Kube, run } from "./kube";
import {
  type AcceptedRelease,
  type AgentState,
  journalBlocks,
  StateStore,
} from "./state";
import { collectHeartbeat, productTarget, readIdentity } from "./status";
import { upgradeAllowedNow } from "./window";

const PHASE_STATE: Record<PromotionJournal["phase"], UpgradeState> = {
  prepared: "backing-up",
  quiescing: "backing-up",
  "backing-up": "backing-up",
  promoting: "upgrading",
  verifying: "verifying",
  accepted: "idle",
  failed: "idle",
  "recovery-required": "recovery-required",
};
const PROMOTION_TIMEOUT_SECONDS = 900;
/** After a promotion that was undone (a failed backup, say), how long before the same release is
 * tried again, so the product is not quiesced every minute. */
export const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
const WORKLOAD = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export type Log = (message: string, fields?: Record<string, unknown>) => void;

export class ManagementAgent {
  readonly store: StateStore;
  readonly flux: Flux;
  /** The upgrade, rollback or support bundle running now, if any. */
  private operation: Promise<void> | null = null;
  private operationTarget: string | null = null;
  private liveJournal: PromotionJournal | null = null;
  private waitingWindow = false;
  private serviceWindow: MaintenanceWindow | null = null;
  private servicePaused = false;
  private message: string | null = null;
  private stateLock: Promise<unknown> = Promise.resolve();
  /** The release whose last attempt was undone, and when. */
  private lastFailure: { digest: string; at: number; error: string } | null =
    null;

  constructor(
    private readonly agent: Agent,
    private readonly kube: Kube,
    private readonly client: ManagementClient,
    private readonly log: Log = (message, fields) =>
      console.log(
        JSON.stringify({ time: new Date().toISOString(), message, ...fields }),
      ),
    private readonly clock: () => Date = () => new Date(),
  ) {
    const { config } = agent;
    this.store = new StateStore(
      kube,
      config.agentNamespace,
      config.stateConfigMap,
    );
    this.flux = new Flux(kube, config);
  }

  private get config() {
    return this.agent.config;
  }

  /** Read-modify-write of the state ConfigMap, one at a time. */
  private updateState(change: (state: AgentState) => void) {
    const next = this.stateLock.then(async () => {
      const { state } = await this.store.read();
      change(state);
      await this.store.saveState(state);
      return state;
    });
    this.stateLock = next.catch(() => undefined);
    return next;
  }

  private async upgradeStatus(
    state: AgentState,
    journal: PromotionJournal | null,
  ) {
    const live = this.liveJournal ?? journal;
    let upgradeState: UpgradeState = "idle";
    if (this.operation && this.liveJournal)
      upgradeState = PHASE_STATE[this.liveJournal.phase];
    else if (journalBlocks(journal)) upgradeState = "recovery-required";
    else if (
      state.paused ||
      this.servicePaused ||
      (await this.suspendedByPerson(state))
    )
      upgradeState = "paused";
    else if (this.waitingWindow) upgradeState = "waiting-window";
    const line =
      upgradeState === "recovery-required"
        ? `recovery-required: ${journal?.error ?? "a promotion stopped"}`
        : this.message;
    return {
      state: upgradeState,
      targetVersion:
        upgradeState === "idle" && !this.operation
          ? null
          : (this.operationTarget ?? live?.toVersion ?? null),
      journal: line ? line.slice(0, 2048) : null,
    };
  }

  /** A person suspended the product's HelmRelease (off level 1): the agent leaves it alone. */
  private async suspendedByPerson(state: AgentState) {
    const release = await this.flux.helmRelease().catch(() => null);
    return (
      release?.spec.suspend === true &&
      !state.suspendedByAgent &&
      (await this.flux.pinnedDigest().catch(() => null)) !== null
    );
  }

  /** One heartbeat, then commands, then the desired version. */
  async tick() {
    const { state, journal } = await this.store.read();
    const heartbeat = await collectHeartbeat({
      config: this.config,
      kube: this.kube,
      flux: this.flux,
      upgrade: await this.upgradeStatus(state, journal),
      acceptedVersion: state.accepted?.version ?? null,
    });
    const reply = await this.client.heartbeat(heartbeat);
    this.serviceWindow = reply.window;
    this.servicePaused = reply.paused;
    await this.handleCommands(reply.commands);
    await this.reconcile(reply);
  }

  /** Runs forever: a heartbeat every minute with up to 10% jitter. */
  async loop(signal?: AbortSignal) {
    while (!signal?.aborted) {
      try {
        await this.tick();
      } catch (error) {
        this.log("heartbeat failed", { error: String(error) });
      }
      const jitter = 1 + Math.random() * 0.1;
      await Bun.sleep(HEARTBEAT_INTERVAL_SECONDS * 1000 * jitter);
    }
  }

  // --- desired state -------------------------------------------------------------------------

  /** The desired release, checked: the manifest's bytes match the digest the service named, it
   * parses strictly, and it is the version the service says it is. */
  async desiredRelease(desired: DesiredState) {
    if (
      (await releaseManifestDigest(desired.releaseManifest)) !==
      desired.releaseManifestSha256
    )
      throw new Error(
        "the release manifest does not match releaseManifestSha256",
      );
    const manifest = parseReleaseManifest(JSON.parse(desired.releaseManifest));
    if (manifest.version !== desired.version)
      throw new Error(
        `the release manifest is ${manifest.version}, not ${desired.version}`,
      );
    const chart =
      this.config.product.chart === "bundle"
        ? desired.charts.bundle
        : desired.charts.openbot;
    return { manifest, digest: chart.digest };
  }

  private insideWindow() {
    return (
      this.serviceWindow !== null &&
      upgradeAllowedNow(this.serviceWindow, this.config.window, this.clock())
    );
  }

  async reconcile(
    reply: Pick<HeartbeatReply, "desired" | "paused" | "window">,
  ) {
    this.waitingWindow = false;
    if (this.operation) return;
    const { state, journal } = await this.store.read();
    if (journalBlocks(journal) || state.paused || reply.paused) return;
    if (await this.suspendedByPerson(state)) return;
    const desired = reply.desired;
    if (!desired) {
      this.message = null;
      return;
    }
    let candidate: { manifest: ReleaseManifest; digest: string };
    try {
      candidate = await this.desiredRelease(desired);
    } catch (error) {
      this.message = `desired release refused: ${error instanceof Error ? error.message : error}`;
      return;
    }
    if (state.rolledBackFrom === desired.version) return;
    if (state.accepted?.digest === candidate.digest) {
      this.message = null;
      return;
    }
    const release: AcceptedRelease = {
      version: desired.version,
      manifest: desired.releaseManifest,
      digest: candidate.digest,
    };
    if (!state.accepted) {
      await this.firstRelease(release, candidate.manifest);
      return;
    }
    const current = parseReleaseManifest(JSON.parse(state.accepted.manifest));
    const plan = planUpgrade(
      {
        manifest: current,
        sourceKind: "stock",
        launcherApi: current.compatibility.launcherApi,
        configSchema: current.compatibility.configSchema,
        extensionApi: current.compatibility.extensionApi,
        intelligenceCapabilities:
          current.compatibility.intelligenceCapabilities,
      },
      candidate.manifest,
      {
        distributionId: current.distribution.id,
        repository: current.distribution.repository,
        channel: current.distribution.channel,
      },
    );
    if (!plan.allowed) {
      this.message = `upgrade to ${desired.version} refused: ${plan.reasons.join("; ")}`;
      return;
    }
    if (!this.insideWindow()) {
      this.waitingWindow = true;
      this.operationTarget = desired.version;
      this.message = `waiting for the maintenance window to upgrade to ${desired.version}`;
      return;
    }
    const failure = this.lastFailure;
    if (
      failure?.digest === candidate.digest &&
      this.clock().getTime() - failure.at < RETRY_AFTER_FAILURE_MS
    ) {
      this.message = `upgrade to ${desired.version} was undone and is retried ${new Date(failure.at + RETRY_AFTER_FAILURE_MS).toISOString()}: ${failure.error}`;
      return;
    }
    this.start(desired.version, async () => {
      try {
        await this.upgrade(current, release, candidate.manifest);
        this.lastFailure = null;
      } catch (error) {
        this.lastFailure = {
          digest: candidate.digest,
          at: this.clock().getTime(),
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    });
  }

  /** No release accepted yet: install on an empty namespace, or adopt the running release when it
   * is the desired one. */
  private async firstRelease(
    release: AcceptedRelease,
    manifest: ReleaseManifest,
  ) {
    const target = productTarget(this.config);
    const server = await serverDeployment(target, run).catch(() => null);
    if (!server && (await this.flux.pinnedDigest()) === null) {
      this.start(release.version, () =>
        this.install(release, manifest, "install"),
      );
      return;
    }
    const identity = await readIdentity(this.config);
    if (!identity || !identityMatches(identity, manifest)) {
      this.message = `the running release (${identity?.version ?? "unknown"}) is not ${release.version}, and the agent has no record of it to plan an upgrade from; set the desired version to the running one first`;
      return;
    }
    if (!this.insideWindow()) {
      this.waitingWindow = true;
      this.operationTarget = release.version;
      this.message = `waiting for the maintenance window to take over ${release.version}`;
      return;
    }
    this.start(release.version, () => this.install(release, manifest, "adopt"));
  }

  private start(target: string, work: () => Promise<void>) {
    this.operationTarget = target;
    this.message = null;
    this.operation = work()
      .catch((error) => {
        this.message = error instanceof Error ? error.message : String(error);
        this.log("operation failed", { target, error: this.message });
      })
      .finally(() => {
        this.operation = null;
        this.operationTarget = null;
        this.liveJournal = null;
      });
  }

  /** Waits for whatever operation is running; for tests and shutdown. */
  async settle() {
    await this.operation;
  }

  private pinsFor(manifest: ReleaseManifest) {
    const image = {
      ...imageParts(selectedImage(manifest)),
      tag: manifest.version,
    };
    return {
      ...promotionValues(manifest, image),
      // The server's internal status port, open to the agent's namespace only, so the agent reads
      // /release without pods/exec. A chart without it ignores the value.
      server: {
        ...promotionValues(manifest, image).server,
        internalStatus: {
          enabled: true,
          allowFrom: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": this.config.agentNamespace,
                },
              },
            },
          ],
        },
      },
    };
  }

  private async applyRelease(
    release: AcceptedRelease,
    manifest: ReleaseManifest,
  ) {
    await this.flux.writePins(
      this.pinsFor(manifest) as unknown as Record<string, unknown>,
    );
    await this.flux.pin(release.digest);
    await this.flux.waitForRelease(release.digest, PROMOTION_TIMEOUT_SECONDS);
  }

  private newJournal(
    from: string,
    to: string,
    backupReference = "none",
  ): PromotionJournal {
    return {
      operation: crypto.randomUUID(),
      phase: "prepared",
      fromVersion: from,
      toVersion: to,
      namespace: this.config.product.namespace,
      release: this.config.product.releaseName,
      backupReference,
      databaseMayHaveChanged: false,
      recovery:
        "No automatic Helm or database rollback. Inspect the HelmRelease, the migration and the rollout. Restore a matching backup, or restart the previous release only if its policy says restart-previous. Then remove journal.json from the agent's state ConfigMap.",
    };
  }

  private async saveJournal(journal: PromotionJournal) {
    this.liveJournal = { ...journal };
    await this.store.saveJournal(journal);
    this.log("promotion", {
      phase: journal.phase,
      to: journal.toVersion,
      error: journal.error,
    });
  }

  /** First install, or taking over a running release that already is the desired one. */
  private async install(
    release: AcceptedRelease,
    manifest: ReleaseManifest,
    mode: "install" | "adopt",
  ) {
    const journal = this.newJournal(
      mode === "adopt" ? release.version : "none",
      release.version,
    );
    try {
      journal.databaseMayHaveChanged = true;
      journal.phase = "promoting";
      await this.saveJournal(journal);
      await this.applyRelease(release, manifest);
      journal.phase = "verifying";
      await this.saveJournal(journal);
      await this.verify(manifest);
      await this.updateState((state) => {
        state.accepted = release;
        state.previous = null;
        state.rolledBackFrom = null;
      });
      journal.phase = "accepted";
      await this.saveJournal(journal);
    } catch (error) {
      journal.error = error instanceof Error ? error.message : String(error);
      journal.phase = "recovery-required";
      await this.saveJournal(journal);
      throw error;
    }
  }

  private async verify(manifest: ReleaseManifest) {
    const target = productTarget(this.config);
    await run(
      [
        "kubectl",
        "--namespace",
        target.namespace,
        "rollout",
        "status",
        "deployment",
        "--selector",
        `app.kubernetes.io/instance=${target.release},app.kubernetes.io/component=server`,
        `--timeout=${PROMOTION_TIMEOUT_SECONDS}s`,
      ],
      { cwd: target.cwd },
    );
    verifyDeployment(await serverDeployment(target, run), manifest, true);
    const identity: ReleaseIdentity | null = await readIdentity(this.config);
    if (!identity || !identityMatches(identity, manifest))
      throw new Error(
        "Running server release identity does not match the candidate",
      );
  }

  /** Upgrade along the policy, through the promotion steps the operator's tool uses. */
  private async upgrade(
    current: ReleaseManifest,
    release: AcceptedRelease,
    candidate: ReleaseManifest,
  ) {
    const target = {
      ...productTarget(this.config),
      timeoutSeconds: PROMOTION_TIMEOUT_SECONDS,
    };
    const before = await serverDeployment(target, run);
    verifyDeployment(before, current, false);
    const operation = operationId(this.clock());
    const maintenance =
      needsMaintenance(candidate) ||
      current.compatibility.database.to !== candidate.compatibility.database.to;
    await runPromotion({
      target,
      run,
      candidate,
      journal: this.newJournal(
        current.version,
        candidate.version,
        maintenance ? `openbot-${operation}` : "none",
      ),
      save: (journal) => this.saveJournal(journal),
      before,
      maintenance,
      backup: async () => {
        await runJob(
          this.kube,
          this.agent.jobs.backup,
          operation,
          this.config.backup.timeoutSeconds,
        );
      },
      apply: () => this.applyRelease(release, candidate),
      declaredSuspension: async () => new Set(),
      accepted: async () => {
        await this.updateState((state) => {
          state.previous = state.accepted;
          state.accepted = release;
          state.rolledBackFrom = null;
        });
      },
    });
  }

  // --- commands ------------------------------------------------------------------------------

  async handleCommands(commands: unknown[]) {
    if (!commands.length) return;
    const { state } = await this.store.read();
    const { accepted, ignored } = await readCommands(
      commands,
      this.config.commandPublicKey,
      this.clock(),
    );
    const fresh = (id: string | null): id is string =>
      id !== null && !state.handledCommands.includes(id);
    for (const entry of ignored) {
      this.log("command ignored", { ...entry });
      if (!fresh(entry.id) || entry.reason === "signature does not verify")
        continue;
      await this.markHandled(entry.id);
      await this.report(entry.id, false, `ignored: ${entry.reason}`);
    }
    for (const command of accepted) {
      if (!fresh(command.id)) continue;
      await this.markHandled(command.id);
      this.log("command", { id: command.id, kind: command.kind });
      try {
        await this.execute(command);
      } catch (error) {
        await this.report(
          command.id,
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private markHandled(id: string) {
    return this.updateState((state) => {
      state.handledCommands = [...state.handledCommands, id].slice(-200);
    });
  }

  private async report(commandId: string, ok: boolean, reason: string) {
    const result: CommandResult = {
      commandId,
      ok,
      reason: reason.slice(0, 2048),
      finishedAt: this.clock().toISOString(),
    };
    try {
      await this.client.result(result);
    } catch (error) {
      this.log("command result not delivered", {
        commandId,
        error: String(error),
      });
    }
  }

  private async execute(command: Command) {
    switch (command.kind) {
      case "pause": {
        const release = await this.flux.helmRelease();
        const suspend = release?.spec.suspend !== true;
        if (suspend) await this.flux.setHelmReleaseSuspended(true);
        await this.updateState((state) => {
          state.paused = true;
          if (suspend) state.suspendedByAgent = true;
        });
        await this.report(
          command.id,
          true,
          "paused: no upgrades until resumed",
        );
        return;
      }
      case "resume": {
        const { state, journal } = await this.store.read();
        if (
          state.suspendedByAgent &&
          !journalBlocks(journal) &&
          (await this.flux.pinnedDigest())
        )
          await this.flux.setHelmReleaseSuspended(false);
        await this.updateState((next) => {
          next.paused = false;
          next.suspendedByAgent = false;
        });
        await this.report(command.id, true, "resumed");
        return;
      }
      case "restart":
        if (this.operation) throw new Error("an upgrade is running");
        await this.restart(command.args.workload);
        await this.report(command.id, true, "restarted");
        return;
      case "rollback":
        await this.rollback(command);
        return;
      case "support-bundle":
        await this.supportBundle(command);
        return;
    }
  }

  private async restart(workload: unknown) {
    const target = productTarget(this.config);
    const selector = `app.kubernetes.io/instance=${target.release}`;
    if (
      workload !== undefined &&
      (typeof workload !== "string" || !WORKLOAD.test(workload))
    )
      throw new Error("restart: workload must be a workload name");
    const names: string[] = [];
    for (const kind of ["deployment", "statefulset"]) {
      const items = await this.kube.list<{ metadata: { name: string } }>(
        target.namespace,
        kind,
        selector,
      );
      for (const item of items)
        if (workload === undefined || item.metadata.name === workload)
          names.push(`${kind}/${item.metadata.name}`);
    }
    if (!names.length)
      throw new Error(
        `restart: no workload of release ${target.release} named ${workload ?? "(any)"}`,
      );
    for (const name of names)
      await this.kube.kubectl([
        "--namespace",
        target.namespace,
        "rollout",
        "restart",
        name,
      ]);
    for (const name of names)
      await this.kube.kubectl(
        [
          "--namespace",
          target.namespace,
          "rollout",
          "status",
          name,
          `--timeout=${PROMOTION_TIMEOUT_SECONDS}s`,
        ],
        { timeoutMs: (PROMOTION_TIMEOUT_SECONDS + 30) * 1000 },
      );
  }

  /** Back to the previous release, only when the current release's policy says restart-previous. */
  async rollback(command: Command) {
    const { state, journal } = await this.store.read();
    if (!state.accepted) throw new Error("no release has been accepted yet");
    const current = parseReleaseManifest(JSON.parse(state.accepted.manifest));
    if (current.upgrade.recovery !== "restart-previous") {
      await this.report(command.id, false, ROLLBACK_REFUSED_REASON);
      return;
    }
    if (journalBlocks(journal))
      throw new Error("recovery-required: a person must recover first");
    if (!state.previous) throw new Error("no previous release to return to");
    if (this.operation) throw new Error("an upgrade is running");
    const previous = state.previous;
    const manifest = parseReleaseManifest(JSON.parse(previous.manifest));
    const from = state.accepted;
    this.start(previous.version, async () => {
      try {
        const target = {
          ...productTarget(this.config),
          timeoutSeconds: PROMOTION_TIMEOUT_SECONDS,
        };
        await runPromotion({
          target,
          run,
          candidate: manifest,
          journal: this.newJournal(from.version, previous.version),
          save: (entry) => this.saveJournal(entry),
          before: await serverDeployment(target, run),
          maintenance: false,
          backup: async () => {},
          apply: () => this.applyRelease(previous, manifest),
          declaredSuspension: async () => new Set(),
          accepted: async () => {
            await this.updateState((next) => {
              next.accepted = previous;
              next.previous = null;
              next.rolledBackFrom = from.version;
            });
          },
        });
        await this.report(
          command.id,
          true,
          `rolled back to ${previous.version}`,
        );
      } catch (error) {
        await this.report(
          command.id,
          false,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    });
  }

  /** A redacted support bundle written to the customer's own storage. Never uploaded. */
  private async supportBundle(command: Command) {
    const operation = operationId(this.clock());
    void (async () => {
      try {
        await runJob(this.kube, this.agent.jobs.supportBundle, operation, 1800);
        await this.report(
          command.id,
          true,
          `written to the ${this.config.supportBundle.pvc} volume as openbot-${operation}.tar.gz; nothing was uploaded`,
        );
      } catch (error) {
        await this.report(
          command.id,
          false,
          error instanceof CommandFailed ? error.message : String(error),
        );
      }
    })();
  }
}
