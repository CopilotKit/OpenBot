import { describe, expect, test } from "bun:test";
import { createShutdownController, interruptibleSleep } from "../src/shutdown";

describe("shutdown controller", () => {
  test("starts unrequested and requests once", () => {
    const seen: string[] = [];
    const controller = createShutdownController((signal) => {
      seen.push(signal);
    });
    expect(controller.shutdownRequested).toBe(false);
    controller.requestShutdown("SIGTERM");
    expect(controller.shutdownRequested).toBe(true);
    controller.requestShutdown("SIGTERM");
    expect(seen).toEqual(["SIGTERM"]);
  });

  test("install wires handlers and uninstall removes them", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const controller = createShutdownController();
    const uninstall = controller.install();
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(controller.shutdownRequested).toBe(false);
  });
});

describe("interruptibleSleep", () => {
  test("resolves true when the delay elapses without shutdown", async () => {
    const result = await interruptibleSleep(30, () => false);
    expect(result).toBe(true);
  });

  test("resolves false early when shutdown is already requested", async () => {
    const result = await interruptibleSleep(30_000, () => true);
    expect(result).toBe(false);
  });

  test("wakes early when shutdown arrives mid-sleep", async () => {
    let shutdown = false;
    const pending = interruptibleSleep(5000, () => shutdown);
    shutdown = true;
    const result = await pending;
    expect(result).toBe(false);
  });

  test("zero delay resolves immediately", async () => {
    expect(await interruptibleSleep(0, () => false)).toBe(true);
    expect(await interruptibleSleep(0, () => true)).toBe(false);
  });
});
