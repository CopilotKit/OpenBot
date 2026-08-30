export type ChannelStatus =
  | "connecting"
  | "online"
  | "setup_required"
  | "reconnecting"
  | "stopped"
  | "error";

export type ChannelProviderStatus =
  | "attached"
  | "unhealthy"
  | "not_attached"
  | "disabled"
  | "channel_not_declared"
  | "unknown";

export type ChannelsStatusSnapshot = {
  overall: ChannelStatus;
  channels: Record<string, ChannelStatus>;
  detail: Record<
    string,
    {
      status: ChannelStatus;
      transport: ChannelStatus;
      provider: ChannelProviderStatus;
    }
  >;
};

/** The credential-free Slack state exposed to unauthenticated deployment checks. */
export type SlackStatus = {
  status: ChannelStatus;
  transport: ChannelStatus;
  provider: ChannelProviderStatus;
};

export function projectSlackStatus(
  snapshot?: ChannelsStatusSnapshot,
): SlackStatus {
  const leg = snapshot?.detail.openbot;
  if (!leg) {
    return { status: "stopped", transport: "stopped", provider: "unknown" };
  }
  return {
    status: leg.status,
    transport: leg.transport,
    provider: leg.provider,
  };
}

type ChannelsActivation = {
  ready(options?: { timeoutMs?: number }): Promise<void>;
};

function reportActivationFailure(error: unknown): void {
  console.error("OpenBot Slack Channel activation failed", error);
}

/** Activation is observable but non-fatal: the HTTP application remains available for setup. */
export async function activateManagedChannels(
  channels: ChannelsActivation | undefined,
  reportFailure: (error: unknown) => void = reportActivationFailure,
): Promise<void> {
  if (!channels) return;
  try {
    await channels.ready({ timeoutMs: 30_000 });
  } catch (error) {
    reportFailure(error);
  }
}

type StoppableChannels = { stop(): Promise<void> };

export type ShutdownFailure = {
  code:
    | "shutdown_stop_failed"
    | "shutdown_stop_timeout"
    | "shutdown_promise_rejected";
  component: string;
};

function reportShutdownFailure(failure: ShutdownFailure): void {
  console.error("OpenBot shutdown failed", failure);
}

type ShutdownFailureReporter = (
  failure: ShutdownFailure,
) => void | Promise<void>;

function reportBestEffort(
  reportFailure: ShutdownFailureReporter,
  failure: ShutdownFailure,
): void {
  try {
    void Promise.resolve(reportFailure(failure)).catch(() => {});
  } catch {
    // Reporting cannot be allowed to keep the process alive during shutdown.
  }
}

type StartShutdownTimeout = (
  callback: () => void,
  timeoutMs: number,
) => () => void;

const startShutdownTimeout: StartShutdownTimeout = (callback, timeoutMs) => {
  const timeout = setTimeout(callback, timeoutMs);
  return () => clearTimeout(timeout);
};

export type GracefulShutdownOptions = {
  channels?: StoppableChannels;
  stopOthers: ReadonlyArray<() => void | Promise<void>>;
  exit: (code: 0 | 1) => void;
  reportFailure?: ShutdownFailureReporter;
  timeoutMs?: number;
  startTimeout?: StartShutdownTimeout;
};

/** Build one idempotent signal handler so SIGINT and SIGTERM cannot tear down twice. */
export function createGracefulShutdown({
  channels,
  stopOthers,
  exit,
  reportFailure = reportShutdownFailure,
  timeoutMs = 10_000,
  startTimeout = startShutdownTimeout,
}: GracefulShutdownOptions): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  let exited = false;
  const exitOnce = (code: 0 | 1) => {
    if (exited) return;
    exited = true;
    try {
      exit(code);
    } catch {
      // There is no recovery path after shutdown; an exit adapter must not restart teardown.
    }
  };
  return () => {
    const stops = [
      ...(channels
        ? [{ component: "channels", stop: () => channels.stop() }]
        : []),
      ...stopOthers.map((stop, index) => ({
        component: `background_${index}`,
        stop,
      })),
    ];
    shutdown ??= (async () => {
      const tracked = stops.map(({ component, stop }) => {
        const state: {
          component: string;
          outcome:
            | { status: "pending" }
            | { status: "fulfilled" }
            | { status: "rejected"; reason: unknown };
        } = { component, outcome: { status: "pending" } };
        const promise = Promise.resolve()
          .then(stop)
          .then(
            (value) => {
              state.outcome = { status: "fulfilled" };
              return value;
            },
            (error) => {
              state.outcome = { status: "rejected", reason: error };
              throw error;
            },
          );
        return { state, promise };
      });
      const allStops = Promise.allSettled(
        tracked.map(({ promise }) => promise),
      );
      let cancelTimeout = () => {};
      const timeout = new Promise<"timeout">((resolve) => {
        cancelTimeout = startTimeout(() => resolve("timeout"), timeoutMs);
      });
      const outcome = await Promise.race([
        allStops.then((results) => ({ kind: "settled" as const, results })),
        timeout.then(() => ({ kind: "timeout" as const })),
      ]);

      if (outcome.kind === "timeout") {
        for (const { state } of tracked) {
          if (state.outcome.status === "rejected") {
            reportBestEffort(reportFailure, {
              code: "shutdown_stop_failed",
              component: state.component,
            });
          } else if (state.outcome.status === "pending") {
            reportBestEffort(reportFailure, {
              code: "shutdown_stop_timeout",
              component: state.component,
            });
          }
        }
        exitOnce(1);
        return;
      }

      cancelTimeout();
      const failures = outcome.results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              {
                code: "shutdown_stop_failed" as const,
                component: stops[index]?.component ?? "unknown",
              },
            ]
          : [],
      );
      for (const failure of failures) {
        reportBestEffort(reportFailure, failure);
      }
      exitOnce(failures.length > 0 ? 1 : 0);
    })().catch(() => {
      reportBestEffort(reportFailure, {
        code: "shutdown_promise_rejected",
        component: "shutdown",
      });
      exitOnce(1);
    });
    return shutdown;
  };
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

export type ShutdownSignalSource = {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

/** Register exactly one shared callback for each supported process signal. */
export function registerShutdownSignals(
  signals: ShutdownSignalSource,
  shutdown: () => Promise<void>,
  reportFailure: ShutdownFailureReporter = reportShutdownFailure,
  exit: (code: 1) => void = (code) => {
    process.exitCode = code;
  },
): () => void {
  let registered = true;
  let exited = false;
  const unregister = () => {
    if (!registered) return;
    registered = false;
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  };
  const onSignal = () => {
    unregister();
    void Promise.resolve()
      .then(shutdown)
      .catch(() => {
        reportBestEffort(reportFailure, {
          code: "shutdown_promise_rejected",
          component: "signal_handler",
        });
        if (exited) return;
        exited = true;
        try {
          exit(1);
        } catch {
          // A failing exit adapter cannot safely restart the shutdown path.
        }
      });
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  return unregister;
}

type ManagedChannelsControl = ChannelsActivation & StoppableChannels;

export type ManagedChannelHostOptions<WebHost> = {
  startWeb(): WebHost;
  stopWeb(host: WebHost): void | Promise<void>;
  channels?: ManagedChannelsControl;
  signals: ShutdownSignalSource;
  stopOthers: ReadonlyArray<() => void | Promise<void>>;
  exit(code: 0 | 1): void;
  reportActivationFailure?: (error: unknown) => void;
};

/** Start HTTP first, install shutdown handling, then wait for non-fatal Channel activation. */
export async function startManagedChannelHost<WebHost>({
  startWeb,
  stopWeb,
  channels,
  signals,
  stopOthers,
  exit,
  reportActivationFailure,
}: ManagedChannelHostOptions<WebHost>): Promise<WebHost> {
  const web = startWeb();
  const shutdown = createGracefulShutdown({
    channels,
    stopOthers: [() => stopWeb(web), ...stopOthers],
    exit,
  });
  registerShutdownSignals(signals, shutdown, undefined, exit);
  await activateManagedChannels(channels, reportActivationFailure);
  return web;
}
