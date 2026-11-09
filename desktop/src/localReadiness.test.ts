import { expect, test } from "bun:test";
import {
  type ChatGateInput,
  chatGate,
  type LocalFailure,
  type LocalReason,
  type LocalReport,
  localFailures,
  type Shortfall,
} from "./localEvalCli";
import { localReadiness, type ReadinessInput } from "./localReadiness";

const reasons: LocalReason[] = [
  "authentication-required",
  "eula-acceptance-required",
  "eula-unavailable",
  "eula-declined",
  "release-unavailable",
  "feature-disabled",
  "unsupported-platform",
  "unsupported-engine",
  "port-unavailable",
  "docker-unavailable",
  "update-recovery-required",
  "incompatible-release",
  "local-command-busy",
  "local-command-failed",
  "confirmation-required",
  "dashboard-unavailable",
  "browser-open-failed",
  "resources-short",
  "unrecognized",
];

function report(overrides: Partial<LocalReport> = {}): LocalReport {
  return {
    outcome: "completed",
    stack: null,
    reason: null,
    readiness: "unknown",
    licence: "unknown",
    licenceExpiresAt: null,
    checksPassed: false,
    ...overrides,
  };
}

function future(readiness: string, licence: string): LocalReport {
  return { ...report(), readiness, licence } as unknown as LocalReport;
}

const base: ReadinessInput = {
  runtime: "running",
  intelligence: report(),
  openBot: "connected",
  provider: "validated",
};

function hasText(said: string, slug: string): boolean {
  return said.toLowerCase().includes(slug);
}

test("every reason gives a plain, non-empty sentence without its own name or Intelligence's", () => {
  for (const reason of reasons) {
    const rows = localReadiness({
      ...base,
      intelligence: report({ outcome: "blocked", reason }),
    });
    for (const row of Object.values(rows)) {
      expect(row.said.length).toBeGreaterThan(0);
      expect(row.said).not.toContain("!");
      expect(row.said).not.toContain("Intelligence");
      expect(hasText(row.said, reason)).toBe(false);
    }
    expect(rows.intelligence.state).toBe("blocked");
  }
});

test("every failure gives a plain, non-empty sentence without its own name or Intelligence's", () => {
  for (const failure of localFailures) {
    const rows = localReadiness({ ...base, intelligence: failure });
    expect(rows.intelligence.said.length).toBeGreaterThan(0);
    expect(rows.intelligence.said).not.toContain("!");
    expect(rows.intelligence.said).not.toContain("Intelligence");
    expect(hasText(rows.intelligence.said, failure)).toBe(false);
    expect(rows.intelligence.state).toBe("blocked");
  }
});

test("the reason and failure lists in this test match the source", () => {
  expect(new Set(reasons).size).toBe(19);
  expect(localFailures.length).toBe(18);
});

test("Docker reasons block the runtime when the probe has no answer", () => {
  const rows = localReadiness({
    ...base,
    runtime: "unknown",
    intelligence: report({ outcome: "blocked", reason: "docker-unavailable" }),
  });
  expect(rows.runtime).toEqual({
    state: "blocked",
    said: "The container engine is not running.",
    action: "retry",
  });
  expect(rows.intelligence.state).toBe("blocked");
  const engine = localReadiness({
    ...base,
    runtime: "unknown",
    intelligence: report({ outcome: "blocked", reason: "unsupported-engine" }),
  });
  expect(engine.runtime.said).toBe(
    "This container engine setup is not supported.",
  );
  expect(engine.runtime.action).toBeUndefined();
});

test("a running probe is not overridden by the CLI", () => {
  const rows = localReadiness({
    ...base,
    intelligence: report({ outcome: "blocked", reason: "docker-unavailable" }),
  });
  expect(rows.runtime.state).toBe("ready");
});

test("runtime probe maps directly", () => {
  expect(localReadiness({ ...base, runtime: "running" }).runtime.state).toBe(
    "ready",
  );
  expect(localReadiness({ ...base, runtime: "not-running" }).runtime).toEqual({
    state: "blocked",
    said: "The container engine is not running.",
    action: "retry",
  });
  expect(localReadiness({ ...base, runtime: "unknown" }).runtime.state).toBe(
    "unknown",
  );
});

test("specific wording and actions", () => {
  const said = (intelligence: ReadinessInput["intelligence"]) =>
    localReadiness({ ...base, intelligence }).intelligence;
  expect(
    said(report({ outcome: "blocked", reason: "port-unavailable" })),
  ).toEqual({
    state: "blocked",
    said: "A port the back end needs is in use.",
    action: "retry",
  });
  expect(
    said(report({ outcome: "blocked", reason: "authentication-required" })),
  ).toEqual({
    state: "blocked",
    said: "Sign in to CopilotKit.",
    action: "sign-in",
  });
  expect(said("cancelled").action).toBe("retry");
  expect(said("cancelled").said).toBe(
    "Stopped at your request before it finished.",
  );
  expect(
    said(report({ outcome: "blocked", reason: "local-command-busy" })).said,
  ).toBe("The back end is still running another command.");
  expect(said("timeout")).toEqual({
    state: "blocked",
    said: "The back end took too long to start, so OpenBot stopped waiting. What it already downloaded is kept, so trying again picks up from there.",
    action: "restart-intelligence",
  });
  expect(said("unexpected-exit").said).toBe(
    "The back end's software quit without saying why. OpenBot's log has the details.",
  );
  // A setup the CLI itself failed says so, not only that the back end could not start.
  expect(
    said(report({ outcome: "failed", reason: "local-command-failed" })).said,
  ).toBe(
    "The back end stopped with an error partway through. OpenBot's log has the details.",
  );
  // The CLI's resource check: which resource is short and where to raise it, on each engine.
  const short = (shortfall: Partial<Shortfall>) =>
    said(
      report({
        outcome: "failed",
        reason: "resources-short",
        shortfall: {
          podman: false,
          cpu: false,
          memory: false,
          disk: false,
          ...shortfall,
        },
      }),
    );
  expect(short({ disk: true })).toEqual({
    state: "blocked",
    said: "Docker is out of disk space. OpenBot needs 40 GB free. Raise the disk limit in Docker Desktop > Settings > Resources, or free space in Docker, then Retry.",
    action: "retry",
  });
  expect(short({ cpu: true }).said).toBe(
    "Docker doesn't have enough CPUs. OpenBot needs 4 free CPUs. Raise the CPU limit in Docker Desktop > Settings > Resources, then Retry.",
  );
  expect(short({ memory: true }).said).toBe(
    "Docker doesn't have enough memory. OpenBot needs 4 GB of free memory. Raise the memory limit in Docker Desktop > Settings > Resources, then Retry.",
  );
  expect(short({ cpu: true, memory: true, disk: true }).said).toBe(
    "Docker doesn't have enough CPUs, memory and disk space. OpenBot needs 4 free CPUs, 4 GB of free memory and 40 GB free. Raise the limits in Docker Desktop > Settings > Resources, or free space in Docker, then Retry.",
  );
  expect(short({ podman: true, disk: true }).said).toBe(
    "Podman is out of disk space. OpenBot needs 40 GB free. Stop your Podman machine, run podman machine set --disk-size 160, start it again, then Retry.",
  );
  // With the CLI's own numbers, as `local_eval.rs` reads them from its error.
  expect(
    short({ disk: true, cpus: "9.8", memoryGb: "18.9", diskGb: "0" }).said,
  ).toBe(
    "Docker has 0 GB of free disk. OpenBot needs 40 GB. Raise the disk limit in Docker Desktop > Settings > Resources, or free space in Docker, then Retry.",
  );
  expect(
    short({ cpu: true, cpus: "3.7", memoryGb: "5.2", diskGb: "51" }).said,
  ).toBe(
    "Docker has 3.7 free CPUs. OpenBot needs 4. Raise the CPU limit in Docker Desktop > Settings > Resources, then Retry.",
  );
  expect(short({ memory: true, memoryGb: "2.9" }).said).toBe(
    "Docker has 2.9 GB of free memory. OpenBot needs 4 GB. Raise the memory limit in Docker Desktop > Settings > Resources, then Retry.",
  );
  expect(
    short({ cpu: true, disk: true, cpus: "3.5", memoryGb: "6", diskGb: "12" })
      .said,
  ).toBe(
    "Docker has 3.5 free CPUs and 12 GB of free disk. OpenBot needs 4 free CPUs and 40 GB of free disk. Raise the limits in Docker Desktop > Settings > Resources, or free space in Docker, then Retry.",
  );
  // A report that does not say which is still about resources, never "partway through".
  expect(
    said(report({ outcome: "failed", reason: "resources-short" })).said,
  ).toBe(
    "Docker doesn't have enough CPUs, memory or disk space for the back end. Raise them in Docker Desktop > Settings > Resources, then Retry.",
  );
  expect(said("unavailable").action).toBeUndefined();
  expect(said("unverified").action).toBe("repair");
  expect(said("invalid-json")).toEqual({
    state: "blocked",
    said: "OpenBot did not understand its back end's reply.",
  });
});

test("a blocked or failed report with no reason still blocks", () => {
  for (const outcome of ["blocked", "failed"] as const) {
    const row = localReadiness({
      ...base,
      intelligence: report({ outcome, reason: null }),
    }).intelligence;
    expect(row.state).toBe("blocked");
    expect(row.action).toBe("restart-intelligence");
  }
});

test("a v1 report is unknown, never ready", () => {
  const row = localReadiness(base).intelligence;
  expect(row).toEqual({
    state: "unknown",
    said: "The back end started. Its licence and readiness are not reported yet.",
  });
  expect(
    localReadiness({ ...base, intelligence: null }).intelligence.state,
  ).toBe("unknown");
});

test("no v1 input ever gives an Intelligence row of ready", () => {
  const inputs: ReadinessInput["intelligence"][] = [
    null,
    ...localFailures,
    ...reasons.map((reason) => report({ outcome: "blocked", reason })),
    ...reasons.map((reason) => report({ outcome: "completed", reason })),
    report(),
    report({ outcome: "failed" }),
    report({ outcome: "blocked" }),
  ];
  for (const intelligence of inputs) {
    expect(
      localReadiness({ ...base, intelligence }).intelligence.state,
    ).not.toBe("ready");
  }
});

test("only exactly ready and valid on a completed report is ready", () => {
  expect(
    localReadiness({ ...base, intelligence: future("ready", "valid") })
      .intelligence.state,
  ).toBe("ready");
  for (const [readiness, licence] of [
    ["not-ready", "valid"],
    ["ready", "expired"],
    ["ready", "unknown"],
    ["unknown", "valid"],
    ["Ready", "valid"],
  ]) {
    expect(
      localReadiness({ ...base, intelligence: future(readiness, licence) })
        .intelligence.state,
    ).not.toBe("ready");
  }
  const failed = {
    ...future("ready", "valid"),
    outcome: "failed",
  } as LocalReport;
  expect(
    localReadiness({ ...base, intelligence: failed }).intelligence.state,
  ).not.toBe("ready");
});

test("OpenBot and provider rows", () => {
  expect(localReadiness({ ...base, openBot: "connected" }).openBot.state).toBe(
    "ready",
  );
  expect(
    localReadiness({ ...base, openBot: "not-connected" }).openBot,
  ).toMatchObject({ state: "blocked", action: "restart-openbot" });
  expect(localReadiness({ ...base, openBot: "unknown" }).openBot.state).toBe(
    "unknown",
  );
  expect(
    localReadiness({ ...base, provider: "validated" }).provider.state,
  ).toBe("ready");
  expect(
    localReadiness({ ...base, provider: "invalid" }).provider,
  ).toMatchObject({
    state: "blocked",
    said: "The AI provider rejected the key.",
  });
  expect(
    localReadiness({ ...base, provider: "unvalidated" }).provider.state,
  ).toBe("unknown");
});

test("rows are independent", () => {
  const before = localReadiness(base);
  const changed = (input: ReadinessInput) => {
    const after = localReadiness(input);
    return (Object.keys(after) as (keyof typeof after)[]).filter(
      (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
    );
  };
  expect(changed({ ...base, runtime: "not-running" })).toEqual(["runtime"]);
  expect(changed({ ...base, openBot: "not-connected" })).toEqual(["openBot"]);
  expect(changed({ ...base, provider: "invalid" })).toEqual(["provider"]);
  expect(changed({ ...base, intelligence: "timeout" })).toEqual([
    "intelligence",
  ]);
  expect(
    changed({
      ...base,
      intelligence: report({ outcome: "blocked", reason: "port-unavailable" }),
    }),
  ).toEqual(["intelligence"]);
});

// chatGate does not take the runtime. So the direction that holds is: if every row is ready, chat
// is open; and if chat is open, the Intelligence, OpenBot and provider rows are ready (the runtime
// row may still be unknown or blocked).
test("agrees with chatGate", () => {
  const intelligences: ChatGateInput["intelligence"][] = [
    null,
    "timeout",
    report(),
    report({ outcome: "blocked", reason: "authentication-required" }),
    future("ready", "valid"),
    future("ready", "expired"),
  ];
  const runtimes: ReadinessInput["runtime"][] = [
    "running",
    "not-running",
    "unknown",
  ];
  const openBots: ChatGateInput["openBot"][] = [
    "connected",
    "not-connected",
    "unknown",
  ];
  const providers: ChatGateInput["provider"][] = [
    "validated",
    "invalid",
    "unvalidated",
  ];
  let allReady = 0;
  for (const intelligence of intelligences)
    for (const runtime of runtimes)
      for (const openBot of openBots)
        for (const provider of providers) {
          const rows = localReadiness({
            runtime,
            intelligence,
            openBot,
            provider,
          });
          const open = chatGate({ intelligence, openBot, provider }).open;
          const every = Object.values(rows).every((r) => r.state === "ready");
          const three = [rows.intelligence, rows.openBot, rows.provider].every(
            (r) => r.state === "ready",
          );
          if (every) {
            allReady += 1;
            expect(open).toBe(true);
          }
          expect(three).toBe(open);
        }
  expect(allReady).toBe(1);
});

test("types: the failure and reason inputs are the upstream ones", () => {
  const failure: LocalFailure = "spawn";
  expect(
    localReadiness({ ...base, intelligence: failure }).intelligence.said,
  ).toBe("OpenBot could not run the back end's software.");
});

test("each readiness state of a valid licence has its own row", () => {
  const row = (readiness: LocalReport["readiness"]) =>
    localReadiness({
      ...base,
      intelligence: report({ readiness, licence: "valid" }),
    }).intelligence;
  expect(row("ready")).toEqual({
    state: "ready",
    said: "The back end is ready.",
  });
  expect(row("starting")).toEqual({
    state: "unknown",
    said: "The back end is starting.",
  });
  expect(row("stopped")).toEqual({
    state: "blocked",
    said: "The back end is stopped.",
    action: "start-intelligence",
  });
  expect(row("degraded")).toEqual({
    state: "blocked",
    said: "The back end is running but not healthy.",
    action: "restart-intelligence",
  });
  expect(row("unknown")).toEqual({
    state: "unknown",
    said: "The back end started. Its licence and readiness are not reported yet.",
  });
});

test("a licence that is not valid blocks a ready Intelligence", () => {
  const row = (licence: LocalReport["licence"]) =>
    localReadiness({
      ...base,
      intelligence: report({ readiness: "ready", licence }),
    }).intelligence;
  expect(row("expired")).toEqual({
    state: "blocked",
    said: "The evaluation licence has expired.",
  });
  expect(row("missing")).toEqual({
    state: "blocked",
    said: "The back end has no evaluation licence.",
  });
  expect(row("invalid")).toEqual({
    state: "blocked",
    said: "The evaluation licence is not valid.",
  });
  expect(row("organization-mismatch")).toEqual({
    state: "blocked",
    said: "The licence belongs to a different organization.",
  });
  expect(row("unknown").state).toBe("unknown");
});

test("a licence expiring in four days is ready with a warning", () => {
  const now = Date.parse("2026-10-21T18:00:00Z");
  const expiring = (licenceExpiresAt: string) =>
    localReadiness({
      ...base,
      now,
      intelligence: report({
        readiness: "ready",
        licence: "valid",
        licenceExpiresAt,
      }),
    }).intelligence;
  expect(expiring("2026-10-25T18:00:00.000Z")).toEqual({
    state: "ready",
    said: "The back end is ready. Its evaluation licence expires within 5 days.",
  });
  expect(expiring("2026-10-27T18:00:00.000Z")).toEqual({
    state: "ready",
    said: "The back end is ready.",
  });
});
