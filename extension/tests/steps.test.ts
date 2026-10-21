import { expect, test } from "bun:test";
import { navigationEvent } from "../src/background/navigation";
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
} from "@openbot/shared/recorder-masking";
import {
  carriesValues,
  createStepAssembler,
  isChatter,
  STEP_TIMING,
  type StepCall,
  saveQuality,
} from "../src/background/steps";

const START = 1_800_000_000_000;

/** An assembler on a clock and timers the test moves by hand; what it sends, in order. */
function harness(
  options: {
    pageOf?: (tabId: number) => Promise<{ url: string; title?: string } | null>;
    /** Fires every timer this many milliseconds before it is due, as a real one can. */
    early?: number;
  } = {},
) {
  const { early = 0, ...assemblerOptions } = options;
  let clock = START;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const sent: CapturedEvent[] = [];
  const steps = createStepAssembler({
    emit: (event) => sent.push(event),
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        // Never earlier than it was set, as a real timer for less than `early` is not.
        const timer = {
          at: clock + (ms > early ? ms - early : ms),
          fn,
          live: true,
        };
        due.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { live: boolean }).live = false;
      },
    },
    ...assemblerOptions,
  });
  return {
    steps,
    sent,
    get now() {
      return clock;
    },
    /** Moves the clock, firing every timer due on the way. */
    advance(ms: number) {
      const end = clock + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due.find((timer) => timer.live && timer.at <= end);
        if (!next) break;
        next.live = false;
        clock = next.at;
        next.fn();
      }
      clock = end;
    },
  };
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

const click = (at: number, name: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "CUSTOM",
    name: "click",
    timestamp: at,
    value: {
      step: "click",
      url: "https://crm.example.test/deals/42",
      target: { tag: "button", role: "button", name, text: name },
      ...extra,
    },
  }) as CapturedEvent;

const edit = (at: number, field: string, value: string) =>
  ({
    type: "CUSTOM",
    name: "input",
    timestamp: at,
    value: {
      step: "change",
      eventType: "change",
      url: "https://crm.example.test/deals/42",
      target: { tag: "input", role: "textbox", name: field, value },
    },
  }) as CapturedEvent;

/** A finished call: a write carries its masked exchange, a read only when it ran. */
function call(
  startedAt: number,
  method: string,
  url: string,
  body?: string,
  options: { endedAt?: number; tabId?: number; response?: string } = {},
): StepCall {
  const write = method !== "GET" && method !== "HEAD";
  return {
    tabId: options.tabId ?? 1,
    startedAt,
    endedAt: options.endedAt ?? startedAt + 80,
    method,
    url,
    ...(write
      ? {
          exchange: {
            url,
            status: 200,
            body:
              body === undefined
                ? { status: "empty" }
                : { status: "complete", text: body, encoding: "utf-8" },
            response: {
              status: "complete",
              text: options.response ?? '{"ok":true}',
              encoding: "utf-8",
            },
          },
        }
      : {}),
  };
}

/** The save a sent step carries. */
const request = (event: CapturedEvent | undefined) =>
  (event?.value as { request?: Record<string, unknown> } | undefined)
    ?.request as
    | { method: string; url: string; [key: string]: unknown }
    | undefined;

test("a click amid the page's noise carries only its save: reads, config POSTs, other tabs and later calls stay out", () => {
  const h = harness();
  const at = START;
  h.steps.step(1, click(at, "Add note"));
  h.steps.call(
    call(at - 2_000, "POST", "https://crm.example.test/api/notes/create", "{}"),
  );
  h.steps.call(call(at + 40, "GET", "https://crm.example.test/api/config"));
  h.steps.call(
    call(
      at + 60,
      "POST",
      "https://crm.example.test/api/user-attributes/fetch",
      '{"keys":["theme"]}',
    ),
  );
  h.steps.call(
    call(
      at + 90,
      "POST",
      "https://crm.example.test/api/deals/42/notes/create",
      '{"text":"Call back"}',
    ),
  );
  h.steps.call(
    call(at + 100, "POST", "https://crm.example.test/api/notes/save", "{}", {
      tabId: 2,
    }),
  );
  h.steps.call(
    call(at + 5_000, "DELETE", "https://crm.example.test/api/notes/9"),
  );
  h.advance(STEP_TIMING.horizonMs + STEP_TIMING.settleMs);
  expect(h.sent).toHaveLength(1);
  expect(request(h.sent[0])).toEqual({
    method: "POST",
    url: "https://crm.example.test/api/deals/42/notes/create",
    status: 200,
    body: {
      status: "complete",
      text: '{"text":"Call back"}',
      encoding: "utf-8",
    },
    response: { status: "complete", text: '{"ok":true}', encoding: "utf-8" },
  });
});

test("a typed form's submit carries the request that holds what was typed, over another write that only sounds like one", () => {
  const h = harness();
  h.steps.step(1, edit(START, "Company name", "Acme Holdings"));
  h.steps.step(1, edit(START + 2_000, "City", "Lyon"));
  const submit = START + 4_000;
  h.steps.step(1, {
    type: "CUSTOM",
    name: "submit",
    timestamp: submit,
    value: {
      step: "submit",
      target: { tag: "form", role: "form", name: "New company" },
    },
  });
  h.steps.call(
    call(
      submit + 30,
      "POST",
      "https://crm.example.test/api/drafts/save",
      '{"draft":true}',
    ),
  );
  h.steps.call(
    call(
      submit + 60,
      "POST",
      "https://crm.example.test/api/companies",
      '{"name":"Acme Holdings","city":"Lyon"}',
    ),
  );
  h.advance(10_000);
  expect(h.sent.map((event) => event.name)).toEqual([
    "input",
    "input",
    "submit",
  ]);
  expect(request(h.sent[2])?.url).toBe(
    "https://crm.example.test/api/companies",
  );
  // The edits own nothing: each closed when the next step began.
  expect(request(h.sent[0])).toBeUndefined();
  expect(request(h.sent[1])).toBeUndefined();
});

test("a POST that only reads (no typed value, no write in its path, not a mutation) is attached to nothing", () => {
  const h = harness();
  h.steps.step(1, click(START, "Contacts"));
  h.steps.call(
    call(
      START + 50,
      "POST",
      "https://crm.example.test/api/chirp/v1/gateway/com.example.views.rpc.ViewsService/getResolvedView",
      '{"objectType":"0-1"}',
    ),
  );
  h.steps.call(
    call(
      START + 70,
      "POST",
      "https://crm.example.test/api/graphql/crm",
      '{"operationName":"Contacts","query":"query Contacts { contacts { id } }"}',
    ),
  );
  h.advance(10_000);
  expect(h.sent).toHaveLength(1);
  expect(request(h.sent[0])).toBeUndefined();
});

test("steps leave in the order they came, each once its window closes or the next step in its tab begins", () => {
  const h = harness();
  h.steps.step(1, click(START, "First"));
  h.steps.step(2, click(START + 100, "Other tab"));
  h.steps.step(1, click(START + 400, "Second"));
  // The first closed when the second began (less the lead): it leaves after its settle, and the others wait their turn.
  h.advance(400 - STEP_TIMING.leadMs + STEP_TIMING.settleMs - 1);
  expect(h.sent).toHaveLength(0);
  h.advance(1);
  expect(
    h.sent.map(
      (event) => (event.value as { target: { name: string } }).target.name,
    ),
  ).toEqual(["First"]);
  h.advance(STEP_TIMING.horizonMs + STEP_TIMING.settleMs);
  expect(
    h.sent.map(
      (event) => (event.value as { target: { name: string } }).target.name,
    ),
  ).toEqual(["First", "Other tab", "Second"]);
});

test("a save that starts after the next step began is the next step's", () => {
  const h = harness();
  h.steps.step(1, click(START, "Close banner"));
  h.steps.step(1, click(START + 600, "Close banner"));
  h.steps.call(
    call(
      START + 10,
      "PUT",
      "https://crm.example.test/api/notifications/1/read",
    ),
  );
  h.steps.call(
    call(
      START + 610,
      "PUT",
      "https://crm.example.test/api/notifications/2/read",
    ),
  );
  h.advance(10_000);
  expect(h.sent.map((event) => request(event)?.url)).toEqual([
    "https://crm.example.test/api/notifications/1/read",
    "https://crm.example.test/api/notifications/2/read",
  ]);
});

test("a save the step's own response handler sends after the window is the step's, through a chain of at most two links", () => {
  const h = harness();
  h.steps.step(1, click(START, "Save"));
  const past = START + STEP_TIMING.windowMs;
  h.steps.call(
    call(START + 100, "GET", "https://crm.example.test/api/token", undefined, {
      endedAt: past - 50,
    }),
  );
  h.steps.call(
    call(
      past + 50,
      "POST",
      "https://crm.example.test/api/messages/send",
      '{"text":"hi"}',
      { endedAt: past + 300 },
    ),
  );
  h.advance(10_000);
  expect(request(h.sent[0])?.url).toBe(
    "https://crm.example.test/api/messages/send",
  );
  // Long after its last call: not the step's.
  const later = harness();
  later.steps.step(1, click(START, "Save"));
  later.steps.call(
    call(
      START + STEP_TIMING.windowMs + 600,
      "POST",
      "https://crm.example.test/api/messages/send",
      "{}",
    ),
  );
  later.advance(10_000);
  expect(request(later.sent[0])).toBeUndefined();
});

test("a suggestion the person clicked wins: the request that carries its text, over the first write", () => {
  const h = harness();
  const chip = "What should I do with Ada Lovelace?";
  h.steps.step(1, click(START, chip));
  h.steps.call(
    call(
      START + 70,
      "POST",
      "https://crm.example.test/rpc/com.example.ConversationsService/createConversation",
      '{"agentId":"a"}',
    ),
  );
  h.steps.call(
    call(
      START + 150,
      "POST",
      "https://crm.example.test/rpc/com.example.ConversationsService/markConversationRead",
      '{"id":1}',
    ),
  );
  h.steps.call(
    call(
      START + 880,
      "POST",
      "https://crm.example.test/rpc/com.example.EngineService/sendMessage",
      '{"message":"What should I do with Ada Lovelace at Acme?"}',
    ),
  );
  h.advance(10_000);
  expect(request(h.sent[0])?.url).toBe(
    "https://crm.example.test/rpc/com.example.EngineService/sendMessage",
  );
});

test("with nothing typed or chosen in a body, the first write is the save", () => {
  const h = harness();
  h.steps.step(1, click(START, "Archive"));
  h.steps.call(
    call(
      START + 20,
      "PATCH",
      "https://crm.example.test/api/deals/42",
      '{"archived":true}',
    ),
  );
  h.steps.call(
    call(
      START + 40,
      "POST",
      "https://crm.example.test/api/activity/create",
      "{}",
    ),
  );
  h.advance(10_000);
  expect(request(h.sent[0])).toMatchObject({ method: "PATCH" });
});

test("a GraphQL mutation is a save; a query never is, even one carrying what was typed", () => {
  expect(
    saveQuality(
      call(
        0,
        "POST",
        "https://crm.example.test/graphql",
        '{"query":"mutation AddNote($t: String!) { addNote(text: $t) { id } }","variables":{"t":"Call back"}}',
      ),
      [],
    ).save,
  ).toBe(true);
  expect(
    saveQuality(
      call(
        0,
        "POST",
        "https://crm.example.test/graphql",
        '{"query":"query Search($q: String!) { search(q: $q) { id } }","variables":{"q":"Acme Holdings"}}',
      ),
      ["Acme Holdings"],
    ),
  ).toEqual({ save: false, carries: true });
  // A persisted query sends only its name.
  expect(
    saveQuality(
      call(
        0,
        "POST",
        "https://crm.example.test/graphql",
        '{"operationName":"UpdateDeal","extensions":{"persistedQuery":{"sha256Hash":"ab"}}}',
      ),
      [],
    ).save,
  ).toBe(true);
});

test("a write-sounding name counts in an operation or the path's last segments, never in a package name or an id", () => {
  const post = (url: string) =>
    saveQuality(call(0, "POST", url, "{}"), []).save;
  expect(post("https://crm.example.test/api/notes/create")).toBe(true);
  expect(post("https://crm.example.test/api/contacts/42/archive")).toBe(true);
  expect(
    post("https://crm.example.test/rpc/com.example.EngineService/sendMessage"),
  ).toBe(true);
  expect(
    post(
      "https://crm.example.test/rpc/com.example.product.updates.FeedbackRpc/getAllowlist",
    ),
  ).toBe(false);
  expect(
    post(
      "https://crm.example.test/rpc/com.example.EngineService/getOrCreateChannel",
    ),
  ).toBe(false);
  expect(post("https://crm.example.test/api/markets/search")).toBe(false);
  expect(post("https://crm.example.test/api/user-attributes/write")).toBe(
    false,
  );
  // PUT, PATCH and DELETE are saves whatever their path says; a read never is.
  expect(
    saveQuality(
      call(0, "PUT", "https://crm.example.test/api/x/MARKED_AS_READ"),
      [],
    ).save,
  ).toBe(true);
  expect(
    saveQuality(call(0, "DELETE", "https://crm.example.test/api/x/1"), []).save,
  ).toBe(true);
  expect(
    saveQuality(call(0, "GET", "https://crm.example.test/api/save"), []).save,
  ).toBe(false);
});

test("a value is found in a body as typed, JSON-escaped or form-encoded; a redacted one never is", () => {
  expect(
    carriesValues('{"name":"Ada \\"the first\\""}', ['Ada "the first"']),
  ).toBe(true);
  expect(carriesValues("name=Ada+Lovelace&city=Lyon", ["Ada Lovelace"])).toBe(
    true,
  );
  expect(carriesValues("name=Ada%20Lovelace", ["Ada Lovelace"])).toBe(true);
  expect(carriesValues('{"name":"Grace"}', ["Ada"])).toBe(false);
  const h = harness();
  h.steps.step(1, edit(START, "Code", "[redacted]"));
  h.steps.step(1, click(START + 1_000, "Continue"));
  h.steps.call(
    call(
      START + 1_050,
      "POST",
      "https://crm.example.test/api/login/verification",
      '{"code":"[redacted]"}',
    ),
  );
  h.advance(10_000);
  // A redacted code matches nothing, and verification is no write word: the step carries no request.
  expect(request(h.sent[1])).toBeUndefined();
});

test("a step waits for a save still in flight when its window closes, up to its cap", () => {
  const h = harness();
  h.steps.step(1, click(START, "Send"));
  h.steps.writeStarted("w1", 1, START + 100);
  h.advance(STEP_TIMING.horizonMs + STEP_TIMING.settleMs + 2_000);
  expect(h.sent).toHaveLength(0);
  h.steps.call(
    call(
      START + 100,
      "POST",
      "https://crm.example.test/api/messages/send",
      "{}",
      { endedAt: h.now },
    ),
  );
  h.steps.writeEnded("w1");
  expect(request(h.sent[0])?.url).toBe(
    "https://crm.example.test/api/messages/send",
  );
  const stuck = harness();
  stuck.steps.step(1, click(START, "Send"));
  stuck.steps.writeStarted("w2", 1, START + 100);
  stuck.advance(STEP_TIMING.horizonMs + STEP_TIMING.inflightCapMs);
  expect(stuck.sent).toHaveLength(1);
});

test("an edit that arrives late (coalesced) still owns what it started", () => {
  const h = harness();
  h.steps.step(1, click(START, "Notes field"));
  // An autosave the edit caused, finished before the coalesced edit reached the service worker.
  h.steps.call(
    call(
      START + 2_050,
      "POST",
      "https://crm.example.test/api/notes/save",
      '{"text":"Call back"}',
    ),
  );
  h.advance(700);
  h.steps.step(1, edit(START + 2_000, "Notes", "Call back"));
  h.advance(10_000);
  expect(request(h.sent[0])).toBeUndefined();
  expect(request(h.sent[1])?.url).toBe(
    "https://crm.example.test/api/notes/save",
  );
});

test("a page change waits for its page's title; a step from an iframe gets its tab's page", async () => {
  const h = harness({
    pageOf: async () => ({
      url: "https://crm.example.test/deals/42",
      title: "Deal 42",
    }),
  });
  h.steps.navigation(1, {
    type: "CUSTOM",
    name: "navigation",
    timestamp: START,
    value: {
      step: "navigate",
      to: "https://crm.example.test/deals/42",
      from: "",
    },
  });
  h.steps.step(1, click(START + 500, "Chat"), true);
  h.advance(STEP_TIMING.redirectMs);
  await flushPromises();
  h.advance(10_000);
  await flushPromises();
  expect(
    h.sent.map((event) => (event.value as { page?: unknown }).page),
  ).toEqual([
    { url: "https://crm.example.test/deals/42", title: "Deal 42" },
    { url: "https://crm.example.test/deals/42", title: "Deal 42" },
  ]);
});

test("a save too large for one event is cut so the whole step fits", () => {
  const h = harness();
  h.steps.step(1, click(START, "Import"));
  h.steps.call(
    call(
      START + 10,
      "POST",
      "https://crm.example.test/api/import/create",
      `{"rows":"${"x".repeat(60_000)}"}`,
      {
        response: `{"echo":"${"y".repeat(60_000)}"}`,
      },
    ),
  );
  h.advance(10_000);
  const bytes = new TextEncoder().encode(JSON.stringify(h.sent[0])).length;
  expect(bytes).toBeLessThanOrEqual(EVENT_BUDGET_BYTES);
  expect(request(h.sent[0])).toMatchObject({
    method: "POST",
    url: "https://crm.example.test/api/import/create",
    body: { status: "truncated", truncated: true },
    response: { status: "truncated", truncated: true },
  });
});

test("flush sends every step held at once, with the save each has so far; clear drops them", () => {
  const h = harness();
  h.steps.step(1, click(START, "Save"));
  h.steps.call(
    call(START + 10, "PUT", "https://crm.example.test/api/deals/42"),
  );
  h.steps.step(1, click(START + 1_000, "Close"));
  h.steps.flush();
  expect(h.sent.map((event) => request(event)?.method ?? null)).toEqual([
    "PUT",
    null,
  ]);
  const dropped = harness();
  dropped.steps.step(1, click(START, "Save"));
  dropped.steps.clear();
  dropped.advance(10_000);
  expect(dropped.sent).toEqual([]);
});

test("a page change queued behind a step that leaves just as its title is due still gets its title", async () => {
  let lookups = 0;
  const h = harness({
    pageOf: async () => {
      lookups += 1;
      return { url: "https://crm.example.test/contacts", title: "Contacts" };
    },
  });
  // The click's window runs its full length, so it leaves exactly when the page change looks up its title.
  const clickAt =
    START +
    STEP_TIMING.redirectMs -
    STEP_TIMING.horizonMs -
    STEP_TIMING.settleMs;
  h.steps.step(1, click(clickAt, "Contacts"));
  h.steps.navigation(1, {
    type: "CUSTOM",
    name: "navigation",
    timestamp: START,
    value: {
      step: "navigate",
      to: "https://crm.example.test/contacts",
      from: "",
    },
  });
  h.advance(STEP_TIMING.redirectMs);
  await flushPromises();
  expect(lookups).toBe(1);
  expect(h.sent.map((event) => event.name)).toEqual(["click", "navigation"]);
  expect((h.sent[1]?.value as { page?: unknown } | undefined)?.page).toEqual({
    url: "https://crm.example.test/contacts",
    title: "Contacts",
  });
});

test("a step whose timer fires a moment early is looked at again, and leaves on time", () => {
  const h = harness({ early: 1 });
  h.steps.step(1, click(START, "Save"));
  h.advance(STEP_TIMING.horizonMs + STEP_TIMING.settleMs - 1);
  expect(h.sent).toHaveLength(0);
  h.advance(1);
  expect(h.sent).toHaveLength(1);
});

test("an edit that echoes the Enter or click just before it (the field's change) leaves the save to that action", () => {
  const h = harness();
  h.steps.step(1, edit(START, "Ask", "When should I call Acme?"));
  h.steps.step(1, {
    type: "CUSTOM",
    name: "key",
    timestamp: START + 1_000,
    value: {
      step: "enter",
      key: "Enter",
      target: { tag: "input", role: "textbox", name: "Ask" },
    },
  });
  h.steps.step(1, edit(START + 1_000, "Ask", "When should I call Acme?"));
  h.steps.call(
    call(
      START + 1_010,
      "POST",
      "https://crm.example.test/api/chat",
      '{"q":"When should I call Acme?"}',
    ),
  );
  h.advance(10_000);
  expect(
    h.sent.map((event) => [event.name, request(event)?.url ?? null]),
  ).toEqual([
    ["input", null],
    ["key", "https://crm.example.test/api/chat"],
    ["input", null],
  ]);
});

test("a write that keeps the page alive or reports on it is never a save: presence, heartbeats, pings, typing, session refreshes, telemetry, tracking and logs", () => {
  for (const path of [
    "/api/chirp/v1/gateway/com.example.assistant.experience.rpc.PresenceRpc/updateBreezePresence",
    "/api/presence/v1/update",
    "/api/heartbeat",
    "/ws/ping",
    "/api/keep-alive",
    "/rpc/ChatService/sendTypingIndicator",
    "/auth/session/refresh",
    "/api/refreshSession",
    "/api/telemetry/save",
    "/api/trackEvent",
    "/api/logs/batch",
    "/api/developer/platform/logging/public/publish/v1/action-logs/create",
  ])
    expect([path, isChatter(path)]).toEqual([path, true]);
  for (const path of [
    "/rpc/com.example.EngineService/sendMessage",
    "/api/login-api/v1/login/verification-code",
    "/api/shipping/labels/create",
    "/api/catalog/items/save",
    "/api/sessions/42/notes",
  ])
    expect([path, isChatter(path)]).toEqual([path, false]);
  // A read receipt the page posts when it shows a conversation is its own; marking a notification read with a PUT is
  // the person dismissing it.
  expect(
    isChatter(
      "/rpc/com.example.engine.rpc.ConversationsService/markConversationRead",
    ),
  ).toBe(true);
  expect(
    isChatter(
      "/api/persistent-notifications/v1/notifications/notification/9/deliveryMethod/BANNER/action/MARKED_AS_READ",
      undefined,
      "PUT",
    ),
  ).toBe(false);
  // A GraphQL mutation is known by its operation, named or not.
  expect(isChatter("/graphql", "UpdatePresence")).toBe(true);
  expect(
    saveQuality(
      call(
        0,
        "POST",
        "https://crm.example.test/graphql",
        '{"query":"mutation { updatePresence(online: true) { ok } }"}',
      ),
      [],
    ).save,
  ).toBe(false);
  expect(
    saveQuality(call(0, "PUT", "https://crm.example.test/api/presence/me"), [])
      .save,
  ).toBe(false);
});

test("opening a chat that only announces presence carries nothing; the message sent after it carries its save", () => {
  const h = harness();
  h.steps.step(1, click(START, "Ask a question"));
  h.steps.call(
    call(
      START + 370,
      "POST",
      "https://crm.example.test/rpc/com.example.PresenceRpc/updateBreezePresence",
      '{"panelOpen":true}',
    ),
  );
  h.steps.call(
    call(
      START + 440,
      "POST",
      "https://crm.example.test/rpc/com.example.ConversationsService/listConversations",
      "{}",
    ),
  );
  h.steps.call(
    call(
      START + 445,
      "POST",
      "https://crm.example.test/rpc/com.example.ConversationsService/markConversationRead",
      '{"conversationId":7}',
    ),
  );
  h.steps.step(1, click(START + 5_000, "Send"));
  h.steps.call(
    call(
      START + 5_060,
      "POST",
      "https://crm.example.test/rpc/com.example.PresenceRpc/updateBreezePresence",
      "{}",
    ),
  );
  h.steps.call(
    call(
      START + 5_090,
      "POST",
      "https://crm.example.test/rpc/com.example.EngineService/sendMessage",
      '{"message":"hi"}',
    ),
  );
  h.advance(20_000);
  expect(h.sent.map((event) => request(event)?.url ?? null)).toEqual([
    null,
    "https://crm.example.test/rpc/com.example.EngineService/sendMessage",
  ]);
});

const change = (at: number, to: string, from = "", navigationType = "push") =>
  ({
    type: "CUSTOM",
    name: "navigation",
    timestamp: at,
    value: { step: "navigate", from, to, navigationType, frameId: 0 },
  }) as CapturedEvent;

test("page changes the page makes one after another, with no step between them, are one step to the final page", async () => {
  const lookups: string[] = [];
  const h = harness({
    pageOf: async () => {
      lookups.push("looked up");
      return {
        url: "https://crm.example.test/reports/view/7",
        title: "Reports",
      };
    },
  });
  h.steps.step(1, click(START, "Continue"));
  h.steps.navigation(
    1,
    change(
      START + 400,
      "https://crm.example.test/home-beta",
      "https://crm.example.test/login/confirm",
    ),
  );
  h.steps.navigation(
    1,
    change(START + 900, "https://crm.example.test/reports"),
  );
  h.steps.navigation(
    1,
    change(START + 1_200, "https://crm.example.test/reports/view"),
  );
  h.steps.navigation(
    1,
    change(
      START + 1_300,
      "https://crm.example.test/reports/view/7",
      "",
      "replace",
    ),
  );
  h.advance(
    STEP_TIMING.horizonMs + STEP_TIMING.settleMs + STEP_TIMING.redirectMs,
  );
  await flushPromises();
  h.advance(1);
  await flushPromises();
  expect(h.sent.map((event) => event.name)).toEqual(["click", "navigation"]);
  expect(h.sent[1]?.value).toMatchObject({
    step: "navigate",
    from: "https://crm.example.test/login/confirm",
    to: "https://crm.example.test/reports/view/7",
    navigationType: "push",
    page: { url: "https://crm.example.test/reports/view/7", title: "Reports" },
  });
  // Looked up once, for the final page.
  expect(lookups).toHaveLength(1);
});

test("a step of the person's between two page changes, or a gap longer than the redirect wait, keeps them apart", async () => {
  const h = harness();
  h.steps.navigation(1, change(START, "https://crm.example.test/contacts"));
  h.steps.step(1, click(START + 300, "Ada Lovelace"));
  h.steps.navigation(
    1,
    change(START + 320, "https://crm.example.test/contacts/9001"),
  );
  h.steps.navigation(
    1,
    change(
      START + 320 + STEP_TIMING.redirectMs + 1,
      "https://crm.example.test/contacts/9001/notes",
    ),
  );
  h.advance(30_000);
  await flushPromises();
  h.advance(1);
  expect(
    h.sent.map((event) => {
      const value = event.value as { to?: string; target?: { name?: string } };
      return value.to ?? value.target?.name;
    }),
  ).toEqual([
    "https://crm.example.test/contacts",
    "Ada Lovelace",
    "https://crm.example.test/contacts/9001",
    "https://crm.example.test/contacts/9001/notes",
  ]);
});

test("a reload or a step back is the person's own page change, never folded into the one before", async () => {
  const h = harness();
  h.steps.navigation(1, change(START, "https://crm.example.test/deals/44"));
  h.steps.navigation(
    1,
    change(START + 300, "https://crm.example.test/deals/44", "", "reload"),
  );
  h.steps.navigation(
    1,
    change(START + 600, "https://crm.example.test/deals/43", "", "traverse"),
  );
  h.advance(30_000);
  await flushPromises();
  h.advance(1);
  expect(
    h.sent.map(
      (event) => (event.value as { navigationType: string }).navigationType,
    ),
  ).toEqual(["push", "reload", "traverse"]);
});

test("an address the person types into the address bar is a page change of its own, never folded into the one before as a redirect", async () => {
  // End-to-end run 2, rows 89034 and 89035: the-internet's reset form landed on /email_sent, then the person typed
  // Wikipedia's address. Chrome's onCommitted says how each page was reached.
  const h = harness();
  const commit = (
    at: number,
    url: string,
    from: string,
    transitionType: string,
    transitionQualifiers: string[],
  ) => ({
    ...navigationEvent(
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        url,
        transitionType,
        transitionQualifiers,
        timeStamp: at,
      },
      "commit",
      from,
    ),
  });
  h.steps.navigation(
    1,
    commit(
      START,
      "https://the-internet.herokuapp.com/email_sent",
      "https://the-internet.herokuapp.com/forgot_password",
      "form_submit",
      ["server_redirect"],
    ),
  );
  // Typed a moment later, well inside the time a redirect of the page before would take.
  h.steps.navigation(
    1,
    commit(
      START + 900,
      "https://en.wikipedia.org/wiki/Main_Page",
      "https://the-internet.herokuapp.com/email_sent",
      "typed",
      ["from_address_bar"],
    ),
  );
  h.advance(30_000);
  await flushPromises();
  h.advance(1);
  expect(
    h.sent.map((event) => {
      const value = event.value as Record<string, unknown>;
      return [
        value.to,
        value.navigationType,
        value.transitionType,
        value.transitionQualifiers,
      ];
    }),
  ).toEqual([
    [
      "https://the-internet.herokuapp.com/email_sent",
      "push",
      "form_submit",
      ["server_redirect"],
    ],
    [
      "https://en.wikipedia.org/wiki/Main_Page",
      "push",
      "typed",
      ["from_address_bar"],
    ],
  ]);
});

test("a redirect folded into the page change before it keeps how that change began", async () => {
  const h = harness();
  const commit = (
    at: number,
    url: string,
    transitionType: string,
    transitionQualifiers: string[],
  ) =>
    navigationEvent(
      {
        tabId: 1,
        frameId: 0,
        parentFrameId: -1,
        url,
        transitionType,
        transitionQualifiers,
        timeStamp: at,
      },
      "commit",
      undefined,
    );
  // A bookmark opened, which the site sends on to its sign-in page.
  h.steps.navigation(
    1,
    commit(START, "https://crm.example.test/", "auto_bookmark", []),
  );
  h.steps.navigation(
    1,
    commit(START + 400, "https://crm.example.test/login", "link", [
      "client_redirect",
    ]),
  );
  h.advance(30_000);
  await flushPromises();
  h.advance(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]?.value).toMatchObject({
    to: "https://crm.example.test/login",
    transitionType: "auto_bookmark",
    transitionQualifiers: [],
  });
});
