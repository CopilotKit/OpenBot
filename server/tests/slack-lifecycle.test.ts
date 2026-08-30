import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  activateManagedChannels,
  createGracefulShutdown,
  projectSlackStatus,
  registerShutdownSignals,
  startManagedChannelHost,
} from "../src/slack/status";
import { testEnvironment } from "./support/environment";

describe("Slack lifecycle status", () => {
  test("projects a joined transport with no Slack provider as setup required", () => {
    expect(
      projectSlackStatus({
        overall: "online",
        channels: { openbot: "setup_required" },
        detail: {
          openbot: {
            status: "setup_required",
            transport: "online",
            provider: "not_attached",
          },
        },
      }),
    ).toEqual({
      transport: "online",
      provider: "not_attached",
      status: "setup_required",
    });
  });

  test("projects a reconnecting Slack provider without certifying it online", () => {
    expect(
      projectSlackStatus({
        overall: "reconnecting",
        channels: { openbot: "reconnecting" },
        detail: {
          openbot: {
            status: "reconnecting",
            transport: "reconnecting",
            provider: "attached",
          },
        },
      }),
    ).toEqual({
      transport: "reconnecting",
      provider: "attached",
      status: "reconnecting",
    });
  });

  test("reports stopped with unknown provider before Channels exists", () => {
    expect(projectSlackStatus()).toEqual({
      status: "stopped",
      transport: "stopped",
      provider: "unknown",
    });
  });
});

describe("managed Channels lifecycle", () => {
  test("reports activation failure with the caught error as a separate argument", async () => {
    const failure = new Error("gateway offline");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await activateManagedChannels({
        ready: async () => {
          throw failure;
        },
      });

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        "OpenBot Slack Channel activation failed",
        failure,
      );
    } finally {
      logged.mockRestore();
    }
  });

  test("SIGTERM and SIGINT share one shutdown and unregister their callbacks", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const signals = {
      on(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        const registered = listeners.get(signal) ?? new Set();
        registered.add(listener);
        listeners.set(signal, registered);
      },
      off(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.get(signal)?.delete(listener);
      },
      emit(signal: "SIGINT" | "SIGTERM") {
        for (const listener of listeners.get(signal) ?? []) listener();
      },
      count(signal: "SIGINT" | "SIGTERM") {
        return listeners.get(signal)?.size ?? 0;
      },
    };
    let channelStops = 0;
    let httpStops = 0;
    const httpStopForces: Array<boolean | undefined> = [];
    let listenerStops = 0;
    const exitCodes: number[] = [];
    let markExited: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    await startManagedChannelHost({
      startWeb: () => ({
        stop(force?: boolean): Promise<void> {
          httpStops += 1;
          httpStopForces.push(force);
          if (force) return Promise.resolve();
          return new Promise(() => {});
        },
      }),
      stopWeb: (web) => web.stop(true),
      channels: {
        ready: async () => {},
        stop: async () => {
          channelStops += 1;
        },
      },
      signals,
      stopOthers: [
        async () => {
          listenerStops += 1;
        },
      ],
      exit: (code) => {
        exitCodes.push(code);
        markExited?.();
      },
    });

    expect(signals.count("SIGINT")).toBe(1);
    expect(signals.count("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await exited;
    await Promise.resolve();

    expect(channelStops).toBe(1);
    expect(httpStops).toBe(1);
    expect(httpStopForces).toEqual([true]);
    expect(listenerStops).toBe(1);
    expect(exitCodes).toEqual([0]);
    expect(signals.count("SIGINT")).toBe(0);
    expect(signals.count("SIGTERM")).toBe(0);
  });

  test("reports failed stops canonically and exits unsuccessfully", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const exitCodes: Array<number | undefined> = [];
    try {
      const shutdown = createGracefulShutdown({
        channels: {
          stop: async () => {
            throw new Error("private stop detail");
          },
        },
        stopOthers: [async () => {}],
        exit: (code) => exitCodes.push(code),
      });

      await shutdown();

      expect(exitCodes).toEqual([1]);
      expect(logged).toHaveBeenCalledWith("OpenBot shutdown failed", {
        code: "shutdown_stop_failed",
        component: "channels",
      });
      expect(JSON.stringify(logged.mock.calls)).not.toContain(
        "private stop detail",
      );
    } finally {
      logged.mockRestore();
    }
  });

  test("times out a hanging stop once and observes its late rejection", async () => {
    let triggerTimeout: (() => void) | undefined;
    let rejectStop: ((error: Error) => void) | undefined;
    let stopCalls = 0;
    const failures: Array<{ code: string; component: string }> = [];
    const exitCodes: number[] = [];
    const shutdown = createGracefulShutdown({
      channels: {
        stop: () => {
          stopCalls += 1;
          return new Promise<void>((_resolve, reject) => {
            rejectStop = reject;
          });
        },
      },
      stopOthers: [],
      exit: (code) => exitCodes.push(code),
      reportFailure: (failure) => failures.push(failure),
      timeoutMs: 25,
      startTimeout: (callback) => {
        triggerTimeout = callback;
        return () => {};
      },
    });

    const first = shutdown();
    const second = shutdown();
    expect(triggerTimeout).toBeFunction();
    triggerTimeout?.();
    await Promise.all([first, second]);

    expect(stopCalls).toBe(1);
    expect(failures).toEqual([
      { code: "shutdown_stop_timeout", component: "channels" },
    ]);
    expect(exitCodes).toEqual([1]);

    rejectStop?.(new Error("private late stop detail"));
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    expect(exitCodes).toEqual([1]);
  });

  test("reports a prompt rejection and a concurrent timeout exactly once", async () => {
    let triggerTimeout: (() => void) | undefined;
    let rejectLateStop: ((error: Error) => void) | undefined;
    const failures: Array<{ code: string; component: string }> = [];
    const exitCodes: number[] = [];
    const shutdown = createGracefulShutdown({
      channels: {
        stop: async () => {
          throw new Error("private prompt rejection detail");
        },
      },
      stopOthers: [
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLateStop = reject;
          }),
      ],
      exit: (code) => exitCodes.push(code),
      reportFailure: (failure) => failures.push(failure),
      timeoutMs: 25,
      startTimeout: (callback) => {
        triggerTimeout = callback;
        return () => {};
      },
    });

    const result = shutdown();
    await Promise.resolve();
    await Promise.resolve();
    triggerTimeout?.();
    await result;

    expect(failures).toEqual([
      { code: "shutdown_stop_failed", component: "channels" },
      { code: "shutdown_stop_timeout", component: "background_0" },
    ]);
    expect(JSON.stringify(failures)).not.toContain("private prompt rejection");
    expect(exitCodes).toEqual([1]);

    rejectLateStop?.(new Error("private late rejection detail"));
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(2);
    expect(JSON.stringify(failures)).not.toContain("private late rejection");
    expect(exitCodes).toEqual([1]);
  });

  test("a broken failure reporter cannot prevent shutdown exit", async () => {
    for (const reportFailure of [
      () => {
        throw new Error("reporter threw");
      },
      async () => {
        throw new Error("reporter rejected");
      },
    ]) {
      const exitCodes: number[] = [];
      const shutdown = createGracefulShutdown({
        channels: {
          stop: async () => {
            throw new Error("private stop detail");
          },
        },
        stopOthers: [],
        exit: (code) => exitCodes.push(code),
        reportFailure,
      });

      await shutdown();
      await Promise.resolve();
      expect(exitCodes).toEqual([1]);
    }
  });

  test("handles a rejecting signal shutdown and still unregisters listeners", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const signals = {
      on(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        const registered = listeners.get(signal) ?? new Set();
        registered.add(listener);
        listeners.set(signal, registered);
      },
      off(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.get(signal)?.delete(listener);
      },
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const exitCodes: number[] = [];
    try {
      registerShutdownSignals(
        signals,
        async () => {
          throw new Error("private shutdown detail");
        },
        undefined,
        (code) => exitCodes.push(code),
      );
      for (const listener of listeners.get("SIGTERM") ?? []) listener();
      for (const listener of listeners.get("SIGINT") ?? []) listener();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
      expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);
      expect(logged).toHaveBeenCalledWith("OpenBot shutdown failed", {
        code: "shutdown_promise_rejected",
        component: "signal_handler",
      });
      expect(JSON.stringify(logged.mock.calls)).not.toContain(
        "private shutdown detail",
      );
      expect(exitCodes).toEqual([1]);
    } finally {
      logged.mockRestore();
    }
  });

  test("terminates when a signal shutdown throws before returning a promise", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const signals = {
      on(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        const registered = listeners.get(signal) ?? new Set();
        registered.add(listener);
        listeners.set(signal, registered);
      },
      off(signal: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.get(signal)?.delete(listener);
      },
    };
    const exitCodes: number[] = [];
    registerShutdownSignals(
      signals,
      () => {
        throw new Error("private synchronous shutdown detail");
      },
      () => {},
      (code) => exitCodes.push(code),
    );

    for (const listener of listeners.get("SIGTERM") ?? []) listener();
    await Promise.resolve();
    await Promise.resolve();

    expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
    expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);
    expect(exitCodes).toEqual([1]);
  });

  test("the production Bun host force-stops active WebSockets", async () => {
    const source = await Bun.file(
      new URL("../src/index.ts", import.meta.url),
    ).text();

    expect(source).toContain("stopWeb: (server) => server.stop(true)");
  });

  test("starts a live web host before managed activation and keeps it live on rejection", async () => {
    const events: string[] = [];
    let rejectActivation: ((error: Error) => void) | undefined;
    const activation = new Promise<void>((_resolve, reject) => {
      rejectActivation = reject;
    });
    const snapshot = {
      overall: "error" as const,
      channels: { openbot: "error" as const },
      detail: {
        openbot: {
          status: "error" as const,
          transport: "error" as const,
          provider: "unknown" as const,
        },
      },
    };
    const app = createApp(
      loadConfig(testEnvironment()),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => projectSlackStatus(snapshot),
    );
    let live: { app: typeof app; stop(): Promise<void> } | undefined;
    const start = startManagedChannelHost({
      startWeb: () => {
        events.push("serve");
        live = { app, stop: async () => {} };
        return live;
      },
      stopWeb: (web) => web.stop(),
      channels: {
        ready: async () => {
          events.push("activate");
          return activation;
        },
        stop: async () => {},
      },
      signals: { on: () => {}, off: () => {} },
      stopOthers: [],
      exit: () => {},
      reportActivationFailure: () => {},
    });

    await Promise.resolve();
    expect(events).toEqual(["serve", "activate"]);
    expect(live).toBeDefined();
    expect(
      (await live?.app.request("http://openbot.local/health"))?.status,
    ).toBe(200);

    rejectActivation?.(new Error("gateway unavailable"));
    await expect(start).resolves.toBe(live);
    const capabilities = await live?.app.request(
      "http://openbot.local/api/capabilities",
    );
    expect(capabilities?.status).toBe(200);
    expect((await capabilities?.json())?.channels.slack).toEqual({
      status: "error",
      transport: "error",
      provider: "unknown",
    });
  });
});
