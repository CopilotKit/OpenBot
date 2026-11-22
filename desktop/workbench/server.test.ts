import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IsAlive,
  leaseDir,
  leasePid,
  releaseLease,
  sortLeases,
  stopPlan,
  takeLease,
  takeStartLock,
  workbenchPort,
} from "./server";

const aliveSet =
  (...pids: number[]): IsAlive =>
  (pid) =>
    pids.includes(pid);

const tempDir = () => mkdtempSync(join(tmpdir(), "workbench-lease-"));

describe("workbenchPort", () => {
  test("is 3021 when WORKBENCH_PORT is not set", () => {
    expect(workbenchPort(undefined)).toBe(3021);
    expect(workbenchPort("")).toBe(3021);
  });

  test("reads WORKBENCH_PORT", () => {
    expect(workbenchPort("3121")).toBe(3121);
  });

  test("refuses a value that is not a port", () => {
    expect(() => workbenchPort("abc")).toThrow("WORKBENCH_PORT");
    expect(() => workbenchPort("70000")).toThrow("WORKBENCH_PORT");
  });

  test("each port has its own lease folder", () => {
    expect(leaseDir(3021)).toBe(join(tmpdir(), "openbot-workbench-3021"));
    expect(leaseDir(3121)).not.toBe(leaseDir(3021));
  });
});

describe("leases", () => {
  test("leasePid reads the pid of a lease name only", () => {
    expect(leasePid("123-abc.lease")).toBe(123);
    expect(leasePid("server.pid")).toBeNull();
    expect(leasePid("start.lock")).toBeNull();
    expect(leasePid("x-abc.lease")).toBeNull();
  });

  test("sortLeases sorts by live pid and leaves out other files", () => {
    expect(
      sortLeases(
        ["1-a.lease", "2-b.lease", "server.pid", "server.log"],
        aliveSet(1),
      ),
    ).toEqual({ live: ["1-a.lease"], stale: ["2-b.lease"] });
  });

  test("stopPlan keeps the server while a live lease remains", () => {
    expect(stopPlan(["7-a.lease"], 99, aliveSet(7, 99)).kill).toBeNull();
  });

  test("stopPlan stops the server when only stale leases remain", () => {
    expect(stopPlan(["7-a.lease"], 99, aliveSet(99))).toEqual({
      kill: 99,
      stale: ["7-a.lease"],
    });
  });

  test("stopPlan never stops a server that the workbench did not start", () => {
    expect(stopPlan([], null, aliveSet()).kill).toBeNull();
  });

  test("stopPlan does nothing for a server that is already gone", () => {
    expect(stopPlan([], 99, aliveSet()).kill).toBeNull();
  });
});

describe("releaseLease", () => {
  test("the starter leaves the server to a live reuser, and the reuser stops it last", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "server.pid"), "99");
    const starter = takeLease(dir, 10);
    const reuser = takeLease(dir, 20);
    const alive = aliveSet(10, 20, 99);

    expect(releaseLease(dir, starter, alive)).toBeNull();
    expect(existsSync(join(dir, starter))).toBe(false);
    expect(existsSync(join(dir, "server.pid"))).toBe(true);

    expect(releaseLease(dir, reuser, alive)).toBe(99);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a reuser stops the server when the starter died without its stop()", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "server.pid"), "99");
    takeLease(dir, 10);
    const reuser = takeLease(dir, 20);

    // Pid 10 is dead: its lease is stale, ignored and removed.
    expect(releaseLease(dir, reuser, aliveSet(20, 99))).toBe(99);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the last lease of a server a person started stops nothing", () => {
    const dir = tempDir();
    const own = takeLease(dir, 10);
    expect(releaseLease(dir, own, aliveSet(10))).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a pid file of a dead server is removed", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "server.pid"), "99");
    const own = takeLease(dir, 10);
    expect(releaseLease(dir, own, aliveSet(10))).toBeNull();
    expect(existsSync(join(dir, "server.pid"))).toBe(false);
  });
});

describe("takeStartLock", () => {
  test("only one live process holds it", () => {
    const dir = tempDir();
    expect(takeStartLock(dir, aliveSet(10, 20), 10)).toBe(true);
    expect(takeStartLock(dir, aliveSet(10, 20), 20)).toBe(false);
  });

  test("a lock of a dead process is taken over", () => {
    const dir = tempDir();
    expect(takeStartLock(dir, aliveSet(10), 10)).toBe(true);
    expect(takeStartLock(dir, aliveSet(20), 20)).toBe(true);
  });
});
