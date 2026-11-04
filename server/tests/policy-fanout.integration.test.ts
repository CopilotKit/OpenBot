import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createEnterpriseStore } from "../src/admin/settings-store";
import { startPolicyListener } from "../src/computer/policy-listener";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import type { PolicyCache } from "../src/policy/cache";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  createTestPolicyCache,
  resetTestPolicy,
  until,
  useTestPolicy,
} from "./support/policy";

/**
 * A boundary an administrator changes has to reach every server, not the one that served the request.
 *
 * OpenBot runs several servers behind a load balancer. The policy is read from memory on every single
 * action, which is right: a round trip per keystroke would be absurd. What was wrong once is that
 * memory was only ever filled at boot, so a new deny rule applied on the one server that happened to
 * receive it and nowhere else. The admin screen reported success, because the rule really was saved,
 * and the audit trail agreed, because it records the boundary each process started with. Both were
 * honest and both were describing something other than what the fleet was enforcing.
 *
 * A deny rule that stops roughly one action in N is worse than no deny rule at all: it looks like it
 * works, so nobody goes looking.
 *
 * The policy lives in Intelligence now, and Intelligence announces every change over its realtime
 * gateway. Another server is a policy cache of its own, subscribed the way the server subscribes, and
 * in the last test it is another process altogether.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const RULE = 'contains(element.name, "submit")';

let cache: PolicyCache;
const others: PolicyCache[] = [];

/** Another server: its own cache, read from Intelligence and subscribed to its announcements. */
async function anotherServer() {
  const other = createTestPolicyCache();
  others.push(other);
  await other.start();
  await until(
    "the other server to subscribe",
    () => other.subscribed(),
    10_000,
  );
  const store = createPolicyStore(DEFAULT_ACTION_POLICY, other);
  await store.load();
  return { cache: other, store };
}

beforeAll(async () => {
  cache = await useTestPolicy();
  await resetTestPolicy();
});

afterEach(async () => {
  for (const other of others.splice(0)) other.stop();
  await resetTestPolicy();
});

describe("a rule added on one server", () => {
  test("is enforced on a server that never received the request", async () => {
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, cache);
    await wroteIt.load();
    const other = await anotherServer();
    const listener = await startPolicyListener(other.cache, other.store);

    try {
      expect(other.store.get().deny).toEqual([]);

      await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });

      // Held in one process this stayed empty forever, and every click on that server went through.
      await until("the rule on the other server", () =>
        other.store.get().deny.includes(RULE),
      );
      expect(other.store.get().deny).toEqual([RULE]);
    } finally {
      await listener.stop();
    }
  });

  test("a reset reaches the other servers too", async () => {
    // The direction that is easy to forget. A reset means the deployment goes back to what
    // configuration says; if only the server that served it forgot the rule, the others would keep
    // refusing actions an administrator believes they have just allowed again.
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, cache);
    await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });
    const other = await anotherServer();
    expect(other.store.get().deny).toEqual([RULE]);

    const listener = await startPolicyListener(other.cache, other.store);
    try {
      await wroteIt.reset();

      await until(
        "the reset on the other server",
        () => other.store.get().deny.length === 0,
      );
      expect(other.store.get().deny).toEqual([]);
      expect(other.store.get().allow).toEqual(DEFAULT_ACTION_POLICY.allow);
    } finally {
      await listener.stop();
    }
  });

  test("the mode travels, so dry-run does not stay on somewhere", async () => {
    // Switching from dry-run to enforce is how an operator turns a boundary on for real. A server
    // still in dry-run records refusals and forwards the actions anyway.
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, cache);
    await wroteIt.set({ mode: "dry-run", deny: [RULE], allow: ["true"] });
    const other = await anotherServer();
    expect(other.store.get().mode).toBe("dry-run");

    const listener = await startPolicyListener(other.cache, other.store);
    try {
      await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });

      await until(
        "enforce on the other server",
        () => other.store.get().mode === "enforce",
      );
      expect(other.store.get().mode).toBe("enforce");
    } finally {
      await listener.stop();
    }
  });

  test("a store with no policy cache is unaffected, so a test without Intelligence still works", async () => {
    // The in-memory store is what unit tests use. It has no fanout because it has no second process
    // to fan out to.
    const store = createPolicyStore(DEFAULT_ACTION_POLICY);
    await store.set({ mode: "enforce", deny: [RULE], allow: ["true"] });
    await store.refresh();

    expect(store.get().deny).toEqual([RULE]);
  });
});

describe("a server that was not listening when it changed", () => {
  test("catches up when its subscription comes back", async () => {
    /*
     * An announcement reaches whoever is subscribed at the time. A replica that was restarting, or
     * whose socket had dropped, is not, so it misses the announcement and would go on enforcing what
     * it read at boot. The cache reads everything again every time its subscription joins, which
     * includes every reconnect, so the boundary is re-read at exactly the moments an announcement
     * could have been missed.
     *
     * Thanks to @NathanTarbert, whose #94 caught this.
     */
    const wroteIt = createPolicyStore(DEFAULT_ACTION_POLICY, cache);
    const other = await anotherServer();
    const listener = await startPolicyListener(other.cache, other.store);
    try {
      // The socket goes away, and the rule changes while it is gone.
      other.cache.stop();
      await wroteIt.set({ mode: "enforce", deny: [RULE], allow: ["true"] });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(other.store.get().deny).toEqual([]);

      // The subscription comes back, and with it the full read.
      await other.cache.start();
      await until("the rule after the reconnect", () =>
        other.store.get().deny.includes(RULE),
      );
      expect(other.store.get().deny).toEqual([RULE]);
    } finally {
      await listener.stop();
    }
  });
});

describe("an administrator's change in one OpenBot process", () => {
  test("reaches a second server process within seconds", async () => {
    /*
     * Not two caches in one process: a second process, with its own memory, its own socket to the
     * gateway and nothing shared with this one but Intelligence. It prints what it enforces every time
     * that changes.
     */
    const observer = Bun.spawn(["bun", "tests/support/policy-observer.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    });
    const lines: Record<string, unknown>[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of observer.stdout) {
        buffered += decoder.decode(chunk);
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.startsWith("{")) lines.push(JSON.parse(line));
          newline = buffered.indexOf("\n");
        }
      }
    })();
    try {
      await until(
        "the second process to be ready",
        () => lines.some((line) => line.ready === true),
        20_000,
      );

      // The two changes an administrator makes on the Admin page, through the stores that page uses.
      const boundary = createPolicyStore(DEFAULT_ACTION_POLICY, cache);
      const enterprise = createEnterpriseStore(database);
      const started = Date.now();
      await boundary.set(
        { mode: "enforce", deny: [RULE], allow: ["true"] },
        "admin@example.test",
      );
      await enterprise.setCapability(
        {
          scopeKind: "group",
          scopeId: "Sales",
          capability: "cloudBrowser",
          allowed: true,
        },
        "admin@example.test",
      );
      await enterprise.setSetting("ssoRequired", true, "admin@example.test");

      const arrived = () =>
        lines.find(
          (line) =>
            Array.isArray(line.deny) &&
            line.deny.includes(RULE) &&
            line.ssoRequired === true &&
            Array.isArray(line.capabilities) &&
            line.capabilities.includes("group:Sales:cloudBrowser=true"),
        );
      await until("all three changes in the second process", () =>
        Boolean(arrived()),
      );
      const elapsed = (arrived()?.at as number) - started;
      console.info(
        JSON.stringify({
          type: "policy-reached-second-process",
          elapsedMs: elapsed,
        }),
      );
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      observer.kill();
      await observer.exited;
      await reading.catch(() => undefined);
    }
  }, 30_000);
});

afterAll(async () => {
  await database.$client.close();
});
