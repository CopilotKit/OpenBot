// server/tests/support/policy-observer.ts
//
// A second OpenBot server process, as far as policy goes: it reads the organization policy from the
// test Intelligence, subscribes to its announcements exactly as the server does, keeps the computer
// boundary current through the same listener, and prints one JSON line every time what it enforces
// changes. `policy-fanout.integration.test.ts` runs it beside itself to prove an administrator's change
// made in one process reaches another.
import { startPolicyListener } from "../../src/computer/policy-listener";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../../src/computer/policy-store";
import { createTestPolicyCache } from "./policy";

const cache = createTestPolicyCache();
await cache.start();
const store = createPolicyStore(DEFAULT_ACTION_POLICY, cache);
await store.load();
const listener = await startPolicyListener(cache, store);

const report = () => {
  // The listener re-reads into the store on the same tick it is told; let it land first.
  queueMicrotask(() =>
    console.log(
      JSON.stringify({
        at: Date.now(),
        deny: store.get().deny,
        mode: store.get().mode,
        ssoRequired: cache.settings().ssoRequired,
        capabilities: cache
          .capabilityRules()
          .map(
            (rule) =>
              `${rule.scopeKind}:${rule.scopeId}:${rule.capability}=${rule.allowed}`,
          )
          .sort(),
      }),
    ),
  );
};
cache.onChange(report);

// Ready only once subscribed: a change made before then would be read by the join's full read instead.
const deadline = Date.now() + 15_000;
while (!cache.subscribed() && Date.now() < deadline)
  await new Promise((resolve) => setTimeout(resolve, 25));
console.log(JSON.stringify({ ready: cache.subscribed() }));

process.on("SIGTERM", () => {
  void listener.stop();
  cache.stop();
  process.exit(0);
});
