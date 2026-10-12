import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { detectChallenge } from "../src/challenge";
import {
  createControl,
  HELP_REQUEST_TTL_MS,
  pageWorthKeeping,
} from "../src/control";
import type { StoredControl } from "../src/control-store";
import { createSessions } from "../src/sessions";

/** A store that survives "restarts": a new control built on it is the computer coming back up. */
function memoryStore() {
  let saved: StoredControl | undefined;
  return {
    load: () => (saved ? structuredClone(saved) : undefined),
    save: (state: StoredControl) => {
      saved = structuredClone(state);
    },
  };
}

function clock(start = "2026-10-12T17:00:00Z") {
  let tick = Date.parse(start);
  return {
    now: () => new Date(tick).toISOString(),
    advance: (ms: number) => {
      tick += ms;
    },
  };
}

const CHALLENGE = "https://chatgpt.com/share/abc";

describe("a handoff remembers the page it is about", () => {
  test("a challenge request records the page it was raised on", () => {
    const time = clock();
    const control = createControl(time.now, { store: memoryStore() });
    const state = control.requestHelp(
      "Complete the challenge.",
      "call-1",
      "cloudflare",
      CHALLENGE,
    );
    expect(state.request?.url).toBe(CHALLENGE);
    expect(control.pageToRestore()).toBe(CHALLENGE);
  });

  test("after the computer restarts, asking again from a blank browser brings the lost page back", () => {
    const time = clock();
    const store = memoryStore();
    createControl(time.now, { store }).requestHelp(
      "Complete the challenge.",
      "call-1",
      "cloudflare",
      CHALLENGE,
    );

    // The process restarts: the waiting request is interrupted, and the browser comes back blank.
    time.advance(20_000);
    const restarted = createControl(time.now, { store });
    expect(restarted.get().request?.status).toBe("interrupted");
    expect(restarted.pageToRestore()).toBeUndefined();

    time.advance(5_000);
    const again = restarted.requestHelp(
      "The browser restarted; please complete the challenge.",
      "call-2",
      "model",
      "about:blank",
    );
    expect(again.request?.url).toBe(CHALLENGE);
    expect(restarted.pageToRestore()).toBe(CHALLENGE);
  });

  test("the page is restorable while a person holds control, and not after they hand back", async () => {
    const time = clock();
    const control = createControl(time.now, { store: memoryStore() });
    const id = control.requestHelp(
      "Solve it.",
      "call-1",
      "cloudflare",
      CHALLENGE,
    ).request!.id;
    await control.take(id);
    expect(control.pageToRestore()).toBe(CHALLENGE);
    control.release(id);
    expect(control.pageToRestore()).toBeUndefined();
  });

  test("an interruption long ago, or one somebody moved on from, does not bring an old page back", () => {
    const time = clock();
    const store = memoryStore();
    createControl(time.now, { store }).requestHelp(
      "Solve it.",
      "call-1",
      "cloudflare",
      CHALLENGE,
    );
    time.advance(1_000);
    const restarted = createControl(time.now, { store });

    time.advance(HELP_REQUEST_TTL_MS + 1_000);
    expect(
      restarted.requestHelp("Something else.", "call-2", "model", "about:blank")
        .request?.url,
    ).toBeUndefined();

    // Cancelled, then asked again: the cancelled request is the latest, so nothing is inherited.
    const latest = restarted.get().request!;
    restarted.cancel(latest.id);
    expect(
      restarted.requestHelp("Another thing.", "call-3", "model", "about:blank")
        .request?.url,
    ).toBeUndefined();
  });
});

const RESET_LINK = "https://bank.example/reset?token=secret";

describe("a stop or reset forgets the page", () => {
  test("a help request after a reset does not reopen the page the reset left", () => {
    const control = createControl(clock().now, { store: memoryStore() });
    control.requestHelp("Reset the password.", "a", "model", RESET_LINK);
    control.interrupt(
      "The computer was reset; the previous task was interrupted.",
    );
    expect(
      control.requestHelp("other", "b", "model", "about:blank").request?.url,
    ).toBeUndefined();
  });

  // The routes close the browser before they interrupt, and a closing browser reaches `renewRun` as
  // a restart that keeps the page. The route's own interrupt has to win; reset renews once more after.
  test("a stop or reset that closes the browser first still forgets it", () => {
    for (const route of ["stop", "reset"] as const) {
      const sessions = createSessions({ isLive: () => false });
      const control = sessions.for("bot").control;
      control.requestHelp("Reset the password.", "a", "model", RESET_LINK);
      sessions.renewRun("bot");
      control.interrupt(
        route === "stop"
          ? "The computer stopped; the previous task was interrupted."
          : "The computer was reset; the previous task was interrupted.",
      );
      if (route === "reset") sessions.renewRun("bot");
      expect(
        control.requestHelp("other", "b", "model", "about:blank").request?.url,
      ).toBeUndefined();
    }
  });

  test("a browser that closes underneath the request still hands its page on", () => {
    const sessions = createSessions({ isLive: () => false });
    const control = sessions.for("bot").control;
    control.requestHelp("Solve it.", "a", "cloudflare", CHALLENGE);
    sessions.renewRun("bot");
    expect(
      control.requestHelp("Again.", "b", "model", "about:blank").request?.url,
    ).toBe(CHALLENGE);
  });
});

describe("a finished request does not keep its page on disk", () => {
  const CODE = "https://example.com/callback?code=abc";

  test("cancelled, completed and expired requests drop the page, in memory and in the store", async () => {
    const time = clock();
    const store = memoryStore();
    const control = createControl(time.now, { store });
    control.cancel(
      control.requestHelp("One.", "c1", "model", CODE).request!.id,
    );
    const completed = control.requestHelp("Two.", "c2", "model", CODE).request!
      .id;
    await control.take(completed);
    control.release(completed);
    control.requestHelp("Three.", "c3", "model", CODE);
    time.advance(HELP_REQUEST_TTL_MS + 1_000);
    expect(control.get().request?.status).toBe("expired");

    const saved = store.load()!;
    expect(saved.requests.map((request) => request.status)).toEqual([
      "cancelled",
      "completed",
      "expired",
    ]);
    expect(saved.requests.map((request) => request.url)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(JSON.stringify(saved)).not.toContain("code=abc");
  });

  test("a restart's page leaves the store once the help TTL has passed", () => {
    const time = clock();
    const store = memoryStore();
    createControl(time.now, { store }).requestHelp(
      "Solve it.",
      "c1",
      "cloudflare",
      CHALLENGE,
    );
    time.advance(1_000);
    const restarted = createControl(time.now, { store });
    expect(store.load()!.requests.at(-1)?.url).toBe(CHALLENGE);

    time.advance(HELP_REQUEST_TTL_MS + 1_000);
    restarted.get();
    expect(store.load()!.requests.at(-1)?.url).toBeUndefined();
  });

  test("a record saved before pages were dropped is cleaned when it is read", () => {
    const time = clock();
    const store = memoryStore();
    const at = time.now();
    store.save({
      version: 1,
      holder: "bot",
      since: at,
      resumeSnapshotRequired: false,
      recoveryRequired: false,
      currentRequestId: "old-2",
      requests: [
        {
          id: "old-1",
          reason: "One.",
          source: "model",
          status: "cancelled",
          createdAt: at,
          updatedAt: at,
          finishedAt: at,
          url: CODE,
        },
        {
          id: "old-2",
          reason: "Two.",
          source: "model",
          status: "interrupted",
          createdAt: at,
          updatedAt: at,
          finishedAt: at,
          interruption:
            "The computer was reset; the previous task was interrupted.",
          url: RESET_LINK,
        },
      ],
      aliases: {},
    });

    time.advance(1_000);
    const control = createControl(time.now, { store });
    const saved = JSON.stringify(store.load());
    expect(saved).not.toContain("code=abc");
    expect(saved).not.toContain("token=secret");
    expect(
      control.requestHelp("other", "b", "model", "about:blank").request?.url,
    ).toBeUndefined();
  });
});

describe("only a real page is worth keeping", () => {
  test("http and https are kept; blank, browser and script pages are not", () => {
    expect(pageWorthKeeping(CHALLENGE)).toBe(CHALLENGE);
    expect(pageWorthKeeping("http://example.com/a")).toBe(
      "http://example.com/a",
    );
    expect(pageWorthKeeping("about:blank")).toBeUndefined();
    expect(pageWorthKeeping("chrome://newtab/")).toBeUndefined();
    expect(pageWorthKeeping("javascript:alert(1)")).toBeUndefined();
    expect(
      pageWorthKeeping(`https://example.com/${"a".repeat(3000)}`),
    ).toBeUndefined();
    expect(pageWorthKeeping(undefined)).toBeUndefined();
  });

  test("a spent Cloudflare challenge token is not kept, the rest of the address is", () => {
    expect(
      pageWorthKeeping("https://chatgpt.com/?__cf_chl_rt_tk=spent-1.0.1.1-abc"),
    ).toBe("https://chatgpt.com/");
    expect(
      pageWorthKeeping(
        "https://chatgpt.com/share/abc?__cf_chl_tk=x&ref=mail&__cf_chl_f_tk=y",
      ),
    ).toBe("https://chatgpt.com/share/abc?ref=mail");
  });
});

describe("a detected challenge remembers its page", () => {
  test("the handoff a Cloudflare challenge raises carries the challenge's address", async () => {
    const control = createControl();
    const page = {
      url: () => "https://chatgpt.com/share/abc",
    } as unknown as Page;
    const challenge = await detectChallenge(page, control, {
      cfMitigated: "challenge",
      toolCallId: "call-1",
    });
    expect(challenge?.kind).toBe("cloudflare");
    expect(control.get().request?.url).toBe("https://chatgpt.com/share/abc");
    expect(control.pageToRestore()).toBe("https://chatgpt.com/share/abc");
  });
});
