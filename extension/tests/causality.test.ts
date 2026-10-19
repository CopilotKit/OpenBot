import { expect, test } from "bun:test";
import {
  CAUSALITY,
  type CallTiming,
  type Cause,
  callSignature,
  createCausalityGate,
  screenCall,
  type Verdict,
} from "../src/background/network/causality";
import { isPrefetch, isTelemetry } from "../src/background/network/telemetry";

/** A gate on a clock and timers the test moves by hand. */
function harness() {
  let clock = 1_800_000_000_000;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const gate = createCausalityGate({
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        const timer = { at: clock + ms, fn, live: true };
        due.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { live: boolean }).live = false;
      },
    },
  });
  const outcomes = new Map<string, Verdict | Cause>();
  return {
    gate,
    get now() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
      for (const timer of due.sort((a, b) => a.at - b.at))
        if (timer.live && timer.at <= clock) {
          timer.live = false;
          timer.fn();
        }
    },
    admit(name: string, call: Omit<CallTiming, "tabId"> & { tabId?: number }) {
      gate.admit(
        { tabId: 1, ...call },
        (cause) => outcomes.set(name, cause),
        (verdict) => outcomes.set(name, verdict),
      );
    },
    outcome: (name: string) => outcomes.get(name),
  };
}

test("a call starting within the window after an action in its tab is the action's; one before it or later is not", () => {
  const h = harness();
  const click = h.now;
  h.gate.action(1, click);
  h.advance(5_000);
  h.admit("api", { startedAt: click + 120, endedAt: click + 300 });
  h.admit("edge", {
    startedAt: click + CAUSALITY.windowMs,
    endedAt: click + CAUSALITY.windowMs + 50,
  });
  h.admit("before", { startedAt: click - 40, endedAt: click + 100 });
  h.admit("late", {
    startedAt: click + CAUSALITY.windowMs + 1,
    endedAt: click + CAUSALITY.windowMs + 40,
  });
  h.admit("other tab", {
    tabId: 2,
    startedAt: click + 120,
    endedAt: click + 300,
  });
  expect(h.outcome("api")).toEqual({ anchor: click, depth: 0 });
  expect(h.outcome("edge")).toEqual({ anchor: click, depth: 0 });
  expect(h.outcome("before")).toBe("unprompted");
  expect(h.outcome("late")).toBe("unprompted");
  expect(h.outcome("other tab")).toBe("unprompted");
});

test("a call its response handler starts continues the chain, for at most two links and three seconds", () => {
  const h = harness();
  const click = h.now;
  h.gate.action(1, click);
  h.advance(10_000);
  // The click's call, answered at +900: the handler asks for more at +1 010, past the window.
  h.admit("create", { startedAt: click + 100, endedAt: click + 900 });
  h.admit("refresh", {
    startedAt: click + 1_010,
    respondedAt: click + 1_200,
    endedAt: click + 1_300,
  });
  h.admit("details", { startedAt: click + 1_400, endedAt: click + 1_500 });
  h.admit("third link", { startedAt: click + 1_600, endedAt: click + 1_700 });
  // Long after the chain's last call ended: the page's own.
  h.admit("idle", { startedAt: click + 2_200, endedAt: click + 2_300 });
  expect(h.outcome("create")).toEqual({ anchor: click, depth: 0 });
  expect(h.outcome("refresh")).toEqual({ anchor: click, depth: 1 });
  expect(h.outcome("details")).toEqual({ anchor: click, depth: 2 });
  expect(h.outcome("third link")).toBe("unprompted");
  expect(h.outcome("idle")).toBe("unprompted");
});

test("a chain never reaches past its horizon, however slow the calls in it", () => {
  const h = harness();
  const click = h.now;
  h.gate.action(1, click);
  h.advance(20_000);
  h.admit("slow", { startedAt: click + 200, endedAt: click + 2_900 });
  h.admit("after slow", { startedAt: click + 2_950, endedAt: click + 3_100 });
  h.admit("too late", { startedAt: click + 3_150, endedAt: click + 3_300 });
  expect(h.outcome("after slow")).toEqual({ anchor: click, depth: 1 });
  expect(h.outcome("too late")).toBe("unprompted");
});

test("a call that ends before its action arrives waits for it, and is dropped when none comes", () => {
  const h = harness();
  const click = h.now;
  // A cached call answered in 2 ms, before the content script's word of the click reached the service worker.
  h.admit("cached", { startedAt: click + 5, endedAt: click + 7 });
  h.admit("poll", { startedAt: click - 3_000 + 10, endedAt: click + 8 });
  expect(h.outcome("cached")).toBeUndefined();
  h.advance(30);
  h.gate.action(1, click);
  expect(h.outcome("cached")).toEqual({ anchor: click, depth: 0 });
  expect(h.outcome("poll")).toBe("unprompted");
  // No action ever explains this one: it goes once it has waited.
  h.admit("background", { startedAt: h.now + 2_000, endedAt: h.now + 2_050 });
  h.advance(2_000 + CAUSALITY.waitMs - 1);
  expect(h.outcome("background")).toBeUndefined();
  h.advance(2);
  expect(h.outcome("background")).toBe("unprompted");
});

test("a held call kept late can be the cause of the held call after it", () => {
  const h = harness();
  const click = h.now;
  h.admit("first", { startedAt: click + 10, endedAt: click + 60 });
  h.admit("follow-up", { startedAt: click + 1_100, endedAt: click + 1_150 });
  h.gate.action(1, click);
  expect(h.outcome("first")).toEqual({ anchor: click, depth: 0 });
  expect(h.outcome("follow-up")).toBe(undefined);
  // The follow-up started 1 040 ms after the first ended: too far to continue it, so it waits and goes.
  h.advance(1_200 + CAUSALITY.waitMs);
  expect(h.outcome("follow-up")).toBe("unprompted");
  const h2 = harness();
  const click2 = h2.now;
  h2.admit("first", { startedAt: click2 + 10, endedAt: click2 + 900 });
  h2.admit("follow-up", {
    startedAt: click2 + 1_050,
    endedAt: click2 + 1_150,
  });
  h2.gate.action(1, click2);
  expect(h2.outcome("follow-up")).toEqual({ anchor: click2, depth: 1 });
});

test("the tab's own repeat of a call it made before is seen; the first one, and one in another tab, are not", () => {
  const { gate } = harness();
  const poll = callSignature("GET", "https://crm.example.test/api/unread", "");
  expect(gate.seen(1, poll, 1_000)).toBe(false);
  expect(gate.seen(1, poll, 31_000)).toBe(true);
  expect(gate.seen(2, poll, 31_000)).toBe(false);
  // The same call started earlier than the one already seen (a page event arriving late) is not its repeat.
  const late = callSignature("POST", "https://crm.example.test/api/x", "{}");
  expect(gate.seen(1, late, 50_000)).toBe(false);
  expect(gate.seen(1, late, 49_000)).toBe(false);
  // Ten minutes on, it is a call of its own again.
  expect(gate.seen(1, poll, 31_000 + CAUSALITY.repeatLookbackMs + 1)).toBe(
    false,
  );
});

test("a call's identity is its method, address without cache busters or fragment, and body", () => {
  const base = callSignature(
    "get",
    "https://crm.example.test/api/feed?page=2&_=1792431916496#top",
    undefined,
  );
  expect(
    callSignature(
      "GET",
      "https://crm.example.test/api/feed?page=2&_=1792431999999",
      "",
    ),
  ).toBe(base);
  expect(
    callSignature("GET", "https://crm.example.test/api/feed?page=3&_=1", ""),
  ).not.toBe(base);
  expect(
    callSignature("POST", "https://crm.example.test/api/graphql", '{"q":"a"}'),
  ).not.toBe(
    callSignature("POST", "https://crm.example.test/api/graphql", '{"q":"b"}'),
  );
});

test("telemetry, analytics, ads and monitoring are recognised by host and path; real API calls are not", () => {
  for (const url of [
    "https://www.google-analytics.com/g/collect?v=2",
    "https://region1.google-analytics.com/g/collect",
    "https://px.ads.linkedin.com/wa/",
    "https://eu.i.posthog.com/e/",
    "https://o123.ingest.us.sentry.io/api/45/envelope/",
    "https://browser-intake-datadoghq.com/api/v2/rum",
    "https://exceptions-eu1.crm.example.test/frontend/observability/page-tracking/store/",
    "https://metrics-fe-eu1.crm.example.test/open-telemetry-public/v1/public/sample-ratios",
    "https://crm.example.test/session-replay-config/v1/config",
    "https://crm.example.test/api/usage-logging/v1/log/multi/no-auth",
    "https://crm.example.test/api/nudge/tracking/v1/nudge-event",
    "https://crm.example.test/api/developer/platform/logging/public/publish/v1/system-logs/batch",
    "https://obs.example.test/mon",
    "https://www.facebook.com/tr/?id=1&ev=PageView",
    "https://capig.example.test/events/abc",
    "https://m.stripe.com/6",
    "https://collector.example.test/v1/traces",
    "https://shop.example.test/cdn-cgi/rum?",
    "https://shop.example.test/_vercel/insights/view",
  ])
    expect([url, isTelemetry(url)]).toEqual([url, true]);
  for (const url of [
    "https://crm.example.test/api/crm-record-cards/v4/container-views/get-view",
    "https://crm.example.test/api/crm/events/v3/timeline/0-1/9001",
    "https://crm.example.test/api/gateway/v1/com.example.assistant.rpc.AssistantService/sendMessage",
    "https://crm.example.test/api/graphql/crm",
    "https://shop.example.test/api/orders/42/tracking",
    "https://shop.example.test/api/payments/collect",
    "https://cloud.example.test/projects/p1/analytics",
    "https://cloud.example.test/logs",
    "https://api.example.test/v1/deals/42",
    "https://app.posthog.com/api/projects/1/insights",
  ])
    expect([url, isTelemetry(url)]).toEqual([url, false]);
  // An error report sent through the page's own tunnel route is known by its body.
  expect(
    isTelemetry(
      "https://cloud.example.test/monitoring",
      '{"event_id":"a","sent_at":"2026-10-19T00:00:00Z","dsn":"https://k@o1.ingest.sentry.io/2"}\n{"type":"event"}',
    ),
  ).toBe(true);
  expect(
    isTelemetry("https://cloud.example.test/monitoring", '{"query":"x"}'),
  ).toBe(false);
});

test("a prefetch is known by the headers the page or the browser puts on it", () => {
  expect(isPrefetch({ "next-router-prefetch": "1", rsc: "1" })).toBe(true);
  expect(isPrefetch({ "Sec-Purpose": "prefetch;prerender" })).toBe(true);
  expect(isPrefetch({ Purpose: "prefetch" })).toBe(true);
  expect(isPrefetch({ rsc: "1", "next-url": "/dashboard" })).toBe(false);
  expect(isPrefetch({})).toBe(false);
});

test("screening drops an aborted call, telemetry, a prefetch and a repeat before any body is read", () => {
  const call = {
    url: "https://crm.example.test/api/deals",
    method: "GET",
    outcome: "ok" as const,
    headers: {},
    repeat: false,
  };
  expect(screenCall(call)).toBeNull();
  expect(screenCall({ ...call, outcome: "error" })).toBeNull();
  expect(screenCall({ ...call, outcome: "aborted" })).toBe("aborted");
  expect(
    screenCall({ ...call, url: "https://www.google-analytics.com/g/collect" }),
  ).toBe("telemetry");
  expect(
    screenCall({ ...call, headers: { "next-router-prefetch": "1" } }),
  ).toBe("prefetch");
  expect(screenCall({ ...call, repeat: true })).toBe("repeat");
});
