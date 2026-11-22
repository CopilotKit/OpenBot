import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_PID_FILE,
  appPort,
  busyPortMessage,
  type IsAlive,
  isAlive,
  leaseDir,
  leasePid,
  livePid,
  portArg,
  processStart,
  readPidFile,
  readServerPid,
  releaseLease,
  reuseOrStart,
  type StopDeps,
  sortLeases,
  stopAppServer,
  stopEarlierAppServer,
  stopPlan,
  stopShared,
  takeLease,
  takeStartLock,
  takeStartLockSync,
  withStartLock,
  workbenchPort,
  writePidFile,
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

  test("appPort is 3023 when WORKBENCH_APP_PORT is not set, and reads it", () => {
    expect(appPort(undefined)).toBe(3023);
    expect(appPort("")).toBe(3023);
    expect(appPort("4103")).toBe(4103);
    expect(() => appPort("x")).toThrow("WORKBENCH_APP_PORT");
  });

  // Two workbenches on two ports never share one app server: the second one's stop would leave
  // it running, or the first one's stop would kill it under the second.
  test("appPort is the workbench port + 2 when WORKBENCH_APP_PORT is not set", () => {
    expect(appPort(undefined, 3021)).toBe(3023);
    expect(appPort(undefined, 4100)).toBe(4102);
    expect(appPort("4200", 4100)).toBe(4200);
    expect(appPort(undefined, 65_535)).toBe(65_533);
  });

  test("portArg reads --port from a command line", () => {
    expect(portArg(["node", "vite", "--config", "x.ts"])).toBeNull();
    expect(portArg(["vite", "--port", "4100", "--strictPort"])).toBe(4100);
    expect(portArg(["vite", "--port=4101"])).toBe(4101);
    expect(() => portArg(["vite", "--port", "x"])).toThrow("--port");
  });

  test("the busy-port message is one line that names the port and how to pick another", () => {
    const workbench = busyPortMessage(4100, "workbench");
    expect(workbench).not.toContain("\n");
    expect(workbench).toContain("4100");
    expect(workbench).toContain("WORKBENCH_PORT=");
    expect(workbench).toContain("--port");
    const app = busyPortMessage(4103, "app");
    expect(app).not.toContain("\n");
    expect(app).toContain("4103");
    expect(app).toContain("WORKBENCH_APP_PORT=");
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

describe("pid files", () => {
  const startOf = (pid: number) => (pid === 99 ? "Sun 9:00" : null);

  test("hold the pid and the start time, and old files with only a pid still read", () => {
    const dir = tempDir();
    writePidFile(join(dir, "a.pid"), 99, startOf);
    expect(readPidFile(join(dir, "a.pid"))).toEqual({
      pid: 99,
      start: "Sun 9:00",
    });
    writeFileSync(join(dir, "b.pid"), "42");
    expect(readPidFile(join(dir, "b.pid"))).toEqual({ pid: 42, start: null });
    expect(readPidFile(join(dir, "none.pid"))).toBeNull();
  });

  test("livePid refuses a pid that now belongs to another process", () => {
    const record = { pid: 99, start: "Sun 9:00" };
    expect(livePid(record, aliveSet(99), startOf)).toBe(99);
    // Same pid, another start time: the system gave the pid to a new process.
    expect(livePid(record, aliveSet(99), () => "Mon 8:00")).toBeNull();
    expect(livePid(record, aliveSet(), startOf)).toBeNull();
    // No start time to compare (old file, or no ps): the pid alone.
    expect(livePid({ pid: 99, start: null }, aliveSet(99), startOf)).toBe(99);
  });

  test("releaseLease never stops a reused pid, and removes its stale server.pid", () => {
    const dir = tempDir();
    writePidFile(join(dir, "server.pid"), 99, () => "Sun 9:00");
    const own = takeLease(dir, 10);
    expect(releaseLease(dir, own, aliveSet(10, 99), () => "Mon 8:00")).toBe(
      null,
    );
    expect(existsSync(join(dir, "server.pid"))).toBe(false);
  });

  test("processStart is the same for one process and null for no process", () => {
    const start = processStart(process.pid);
    expect(start).not.toBeNull();
    expect(processStart(process.pid)).toBe(start);
    expect(readServerPid(tempDir())).toBeNull();
  });
});

describe("stop and reuse under the start lock", () => {
  const A = 10;
  const B = 20;
  const lock = (pid: number, alive: IsAlive) => ({ alive, pid, pollMs: 5 });

  // The race: process A holds the last lease and stops the server. Process B takes a lease after
  // A's lease scan, while the server still answers (it has not exited yet). Without one lock over
  // both, B reused the dying server, and A's stop then read B's new app server from
  // app-server.pid and killed it.
  test("a reuse that arrives during the last holder's stop waits, then starts a new server", async () => {
    const dir = tempDir();
    const pids = new Set([A, B, 99, 700]);
    const alive: IsAlive = (pid) => pids.has(pid);
    const noStart = () => null;
    writePidFile(join(dir, "server.pid"), 99, noStart);
    writePidFile(join(dir, APP_PID_FILE), 700, noStart);
    const leaseA = takeLease(dir, A);
    // The old server answers until it exited.
    let answering = true;
    let reuse: Promise<boolean> | undefined;
    let reuseAsked = false;
    const signalled: number[] = [];
    const appsStopped: (number | null)[] = [];
    const deps: StopDeps = {
      alive,
      startOf: noStart,
      signal(pid) {
        signalled.push(pid);
        // B arrives now: after A's scan, before the server exited.
        takeLease(dir, B);
        reuse = reuseOrStart(
          dir,
          {
            answers: async () => {
              reuseAsked = true;
              return answering;
            },
            start: async () => {
              pids.add(100);
              pids.add(701);
              writePidFile(join(dir, "server.pid"), 100, noStart);
              writePidFile(join(dir, APP_PID_FILE), 701, noStart);
              answering = true;
            },
          },
          lock(B, alive),
        );
      },
      async waitForExit(pid) {
        await Bun.sleep(50);
        // B has not looked yet: it waits for the lock that A holds.
        expect(reuseAsked).toBe(false);
        pids.delete(pid);
        answering = false;
      },
      async stopApp(app) {
        appsStopped.push(app?.pid ?? null);
        if (app) pids.delete(app.pid);
      },
    };

    expect(await stopShared(dir, leaseA, deps, lock(A, alive))).toBe(99);
    // B started its own server: it did not reuse the one that A stopped.
    expect(await reuse).toBe(true);
    expect(signalled).toEqual([99]);
    // A stopped the old app server, the one it read before the stop, never B's.
    expect(appsStopped).toEqual([700]);
    expect(alive(100) && alive(701)).toBe(true);
    expect(readPidFile(join(dir, APP_PID_FILE))?.pid).toBe(701);
    expect(existsSync(join(dir, "start.lock"))).toBe(false);
  });

  test("a lease taken before the stop's scan keeps the server, and the holder reuses it", async () => {
    const dir = tempDir();
    const alive = aliveSet(A, B, 99);
    writePidFile(join(dir, "server.pid"), 99, () => null);
    const leaseA = takeLease(dir, A);
    takeLease(dir, B);
    const deps: StopDeps = {
      alive,
      startOf: () => null,
      signal: () => {
        throw new Error("signalled a server that B still holds");
      },
      waitForExit: async () => {},
      stopApp: async () => {},
    };
    expect(await stopShared(dir, leaseA, deps, lock(A, alive))).toBeNull();
    const started = await reuseOrStart(
      dir,
      { answers: async () => true, start: async () => {} },
      lock(B, alive),
    );
    expect(started).toBe(false);
  });

  test("withStartLock fails when another live process keeps the lock", async () => {
    const dir = tempDir();
    const alive = aliveSet(A, B);
    expect(takeStartLock(dir, alive, B)).toBe(true);
    await expect(
      withStartLock(dir, async () => 1, {
        alive,
        pid: A,
        timeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toThrow("start lock");
  });
});

describe("stopAppServer", () => {
  // The app server did not end on the workbench server's SIGTERM, and the workbench server had
  // removed app-server.pid at once, so nothing stopped it. stop() now reads the record before it
  // stops the workbench server, and stopAppServer stops the app server's group.
  test("stops an app server group that outlived the workbench server", async () => {
    const dir = tempDir();
    const child = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30 & wait"], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      writePidFile(join(dir, APP_PID_FILE), child.pid);
      const record = readPidFile(join(dir, APP_PID_FILE));
      await stopAppServer(record, dir);
      await child.exited;
      expect(isAlive(child.pid)).toBe(false);
      expect(existsSync(join(dir, APP_PID_FILE))).toBe(false);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }, 20_000);

  test("never signals a pid that now belongs to another process, and keeps a newer file", async () => {
    const dir = tempDir();
    const child = Bun.spawn(["sleep", "30"], {
      detached: true,
      stdout: "ignore",
    });
    try {
      writePidFile(join(dir, APP_PID_FILE), 4242, () => null);
      await stopAppServer({ pid: child.pid, start: "not its start" }, dir);
      expect(isAlive(child.pid)).toBe(true);
      expect(readPidFile(join(dir, APP_PID_FILE))?.pid).toBe(4242);
    } finally {
      child.kill("SIGKILL");
    }
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

describe("takeStartLockSync", () => {
  // The exit hook: a stopper that saw this process's lease holds the lock for its scan only. The
  // hook waits for it, so it does not leave a server running with no lease.
  test("takes the lock once its holder lets it go", async () => {
    const dir = tempDir();
    // A live process holds the lock for 300 ms, as a stopper does for its lease scan.
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { takeStartLock } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
import { rmSync } from "node:fs";
if (!takeStartLock(${JSON.stringify(dir)})) process.exit(2);
console.log("held");
await Bun.sleep(300);
rmSync(${JSON.stringify(join(dir, "start.lock"))});
await Bun.sleep(5_000);`,
      ],
      { stdout: "pipe" },
    );
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "held",
      );
      expect(takeStartLock(dir)).toBe(false);
      const from = Date.now();
      expect(takeStartLockSync(dir, 3_000)).toBe(true);
      expect(Date.now() - from).toBeLessThan(3_000);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  test("gives up after its wait while a live process holds the lock", () => {
    const dir = tempDir();
    expect(takeStartLock(dir, aliveSet(10, 20), 10)).toBe(true);
    const from = Date.now();
    expect(takeStartLockSync(dir, 100, aliveSet(10, 20), 20)).toBe(false);
    expect(Date.now() - from).toBeGreaterThanOrEqual(100);
  });
});

describe("spawnShared", () => {
  // A worker's command stops with a signal to its whole process group (Ctrl+C, or a timeout).
  // The shared server that this command started must keep running for the other lease holders.
  test("a signal to the starter's process group does not stop the shared process", async () => {
    const dir = tempDir();
    const script = join(dir, "starter.ts");
    writeFileSync(
      script,
      `import { spawnShared } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
const proc = spawnShared(["sleep", "30"], ${JSON.stringify(dir)}, ${JSON.stringify(join(dir, "log"))});
console.log(proc.pid);
await Bun.sleep(30_000);
`,
    );
    // The starter gets its own group too, so the signal below reaches only the starter's group.
    const starter = Bun.spawn(["bun", script], {
      detached: true,
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = starter.stdout.getReader();
    const first = await reader.read();
    const sharedPid = Number(new TextDecoder().decode(first.value).trim());
    expect(Number.isInteger(sharedPid) && sharedPid > 0).toBe(true);
    try {
      process.kill(-starter.pid, "SIGTERM");
      await starter.exited;
      await Bun.sleep(100);
      expect(isAlive(sharedPid)).toBe(true);
    } finally {
      try {
        process.kill(sharedPid, "SIGKILL");
      } catch {}
    }
  });
});

describe("stopEarlierAppServer", () => {
  const startOf = (pid: number) => (pid === 77 ? "Mon 10:00" : null);
  const setup = (start = "Mon 10:00") => {
    const path = join(tempDir(), "app-server.pid");
    writeFileSync(path, `77\n${start}\n`);
    return path;
  };

  // A crash a few seconds after a start: the earlier app server lives but does not answer yet.
  // It is stopped and waited for, not forgotten while it still runs.
  test("stops a live app server that does not answer yet, and waits until it exits", async () => {
    const path = setup();
    let running = true;
    const signals: string[] = [];
    await stopEarlierAppServer(path, {
      alive: (pid) => pid === 77 && running,
      startOf,
      signal: (pid, signal) => {
        signals.push(`${pid} ${signal}`);
        setTimeout(() => {
          running = false;
        }, 120);
      },
      timeoutMs: 2_000,
    });
    expect(signals).toEqual(["77 SIGTERM"]);
    expect(running).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("kills one that does not end on SIGTERM", async () => {
    const path = setup();
    let running = true;
    const signals: string[] = [];
    await stopEarlierAppServer(path, {
      alive: (pid) => pid === 77 && running,
      startOf,
      signal: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") running = false;
      },
      timeoutMs: 100,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(path)).toBe(false);
  });

  test("keeps the record of one that outlives SIGKILL, so the next run tries again", async () => {
    const path = setup();
    await stopEarlierAppServer(path, {
      alive: (pid) => pid === 77,
      startOf,
      signal: () => {},
      timeoutMs: 50,
    });
    expect(existsSync(path)).toBe(true);
  });

  test("never signals a dead pid or a pid now used by another process; only removes the file", async () => {
    for (const [path, alive] of [
      [setup(), () => false],
      [setup("Sun 09:00"), (pid: number) => pid === 77],
    ] as const) {
      const signals: string[] = [];
      await stopEarlierAppServer(path, {
        alive,
        startOf,
        signal: (_pid, signal) => signals.push(signal),
        timeoutMs: 50,
      });
      expect(signals).toEqual([]);
      expect(existsSync(path)).toBe(false);
    }
  });
});
