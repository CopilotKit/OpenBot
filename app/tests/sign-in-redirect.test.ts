import { describe, expect, test } from "bun:test";
import {
  fallbackMethod,
  finishingText,
  loopbackState,
  type RedirectArrival,
  type RedirectSteps,
  signInThroughDesktop,
  takesRedirect,
} from "@/lib/ai-connection/sign-in-redirect";
import type { AiSignIn, AiSignInStatus } from "@/lib/api/generated/model";
import { ClientError } from "@/lib/client";

/**
 * A Claude or ChatGPT plan sign-in the server runs, finished inside OpenBot Desktop with nothing
 * pasted (lib/ai-connection/sign-in-redirect.ts): when it is taken, what goes to the server, and
 * every way it falls back to the paste.
 *
 * The provider pages are the server's own: Claude's authorize address as it is built with the
 * loopback redirect and without it (platform.claude.com's code page), and ChatGPT's browser
 * sign-in, whose redirect is fixed at localhost:1455.
 */

const PORT = 53682;
const CLAUDE_STATE = "Q2xhdWRlU3RhdGVfMzJieXRlc19vZl9yYW5kb20";
const CLAUDE_AUTHORIZE = "https://claude.com/cai/oauth/authorize";

function claudePage(redirect: string): string {
  const url = new URL(CLAUDE_AUTHORIZE);
  for (const [name, value] of [
    ["client_id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"],
    ["response_type", "code"],
    ["redirect_uri", redirect],
    ["scope", "user:inference"],
    ["code_challenge", "Y2hhbGxlbmdl"],
    ["code_challenge_method", "S256"],
    ["state", CLAUDE_STATE],
  ])
    url.searchParams.set(name, value);
  return url.toString();
}
/** Claude's page with Desktop's redirect, as the server builds it when given the port. */
const CLAUDE_LOOPBACK = claudePage(`http://localhost:${PORT}/callback`);
/** Claude's page that shows a code to copy: a server that ignored the port. */
const CLAUDE_CODE_PAGE = `${claudePage("https://platform.claude.com/oauth/code/callback")}&code=true`;
/** ChatGPT's browser sign-in, the spec's example: its redirect fixed at localhost:1455. */
const CHATGPT_PAGE =
  "https://auth.openai.com/oauth/authorize?client_id=example&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=example&code_challenge_method=S256&state=example";

describe("whether Desktop takes the redirect", () => {
  const base = {
    inDesktop: true,
    serverRun: true,
    login: "plan" as const,
    method: undefined,
    pasteBack: false,
  };
  test("inside Desktop, a Claude plan and ChatGPT's browser sign-in the server runs", () => {
    expect(takesRedirect({ ...base, provider: "anthropic" })).toBe(true);
    expect(takesRedirect({ ...base, provider: "openai" })).toBe(true);
    expect(
      takesRedirect({ ...base, provider: "openai", method: "browser" }),
    ).toBe(true);
  });
  test("never in a plain browser, so the paste stays exactly as it is there", () => {
    expect(
      takesRedirect({ ...base, inDesktop: false, provider: "anthropic" }),
    ).toBe(false);
    expect(
      takesRedirect({ ...base, inDesktop: false, provider: "openai" }),
    ).toBe(false);
  });
  test("never for ChatGPT's code, another provider, a key, Desktop's own plan sign-in, or after falling back", () => {
    expect(
      takesRedirect({ ...base, provider: "openai", method: "device" }),
    ).toBe(false);
    expect(takesRedirect({ ...base, provider: "xai" })).toBe(false);
    expect(
      takesRedirect({ ...base, provider: "anthropic", login: "api-key" }),
    ).toBe(false);
    expect(
      takesRedirect({ ...base, provider: "anthropic", serverRun: false }),
    ).toBe(false);
    expect(
      takesRedirect({ ...base, provider: "anthropic", pasteBack: true }),
    ).toBe(false);
  });
});

describe("where Desktop can't take it, what the person gets today", () => {
  test("Claude: its code to paste; ChatGPT: its code sign-in first, never the address paste", () => {
    expect(fallbackMethod("anthropic")).toBeUndefined();
    expect(fallbackMethod("openai")).toBe("device");
  });
});

describe("the provider's page sends the browser to Desktop", () => {
  test("Claude's, with the port Desktop listens on: its state", () => {
    expect(loopbackState(CLAUDE_LOOPBACK, "anthropic", PORT)).toBe(
      CLAUDE_STATE,
    );
  });
  test("Claude's code page, or another port: not Desktop's", () => {
    expect(loopbackState(CLAUDE_CODE_PAGE, "anthropic", PORT)).toBeNull();
    expect(loopbackState(CLAUDE_LOOPBACK, "anthropic", PORT + 1)).toBeNull();
    expect(
      loopbackState(
        claudePage(`http://localhost:${PORT}/elsewhere`),
        "anthropic",
        PORT,
      ),
    ).toBeNull();
    expect(
      loopbackState(
        claudePage(`https://localhost:${PORT}/callback`),
        "anthropic",
        PORT,
      ),
    ).toBeNull();
    expect(loopbackState("not an address", "anthropic", PORT)).toBeNull();
  });
  test("ChatGPT's browser sign-in, always at localhost:1455", () => {
    expect(loopbackState(CHATGPT_PAGE, "openai", 1455)).toBe("example");
  });
});

describe("what goes to the server", () => {
  const arrived = (given: Partial<RedirectArrival>): RedirectArrival => ({
    code: null,
    state: "example",
    error: null,
    ...given,
  });
  test("Claude: code#state, the shape Claude's own page shows", () => {
    expect(
      finishingText(
        "anthropic",
        arrived({ code: "Zm9vYmFyLWNvZGU", state: CLAUDE_STATE }),
      ),
    ).toEqual({ send: `Zm9vYmFyLWNvZGU#${CLAUDE_STATE}` });
  });
  test("ChatGPT: the whole address the browser was sent to, as a person would paste it", () => {
    expect(
      finishingText("openai", arrived({ code: "ac_ZXhhbXBsZS1jb2Rl" })),
    ).toEqual({
      send: "http://localhost:1455/auth/callback?code=ac_ZXhhbXBsZS1jb2Rl&state=example",
    });
  });
  test("declined: Claude's ends here, ChatGPT's goes on for the server to end in its words", () => {
    expect(
      finishingText("anthropic", arrived({ error: "access_denied" })),
    ).toEqual({ failed: "The Claude sign-in wasn't approved. Sign in again." });
    expect(
      finishingText("openai", arrived({ error: "access_denied" })),
    ).toEqual({
      send: "http://localhost:1455/auth/callback?error=access_denied&state=example",
    });
  });
  test("nothing arrived: didn't finish", () => {
    expect(finishingText("anthropic", arrived({}))).toEqual({
      failed: "The sign-in didn't finish. Try again.",
    });
    expect(finishingText("openai", arrived({ code: " " }))).toEqual({
      failed: "The sign-in didn't finish. Try again.",
    });
  });
});

/** The server's answer to startPersonalAiSignIn, in the spec's shape. */
function started(url: string, provider: "anthropic" | "openai"): AiSignIn {
  return {
    id:
      provider === "anthropic" ? "Y2xhdWRlLXNpZ24taW4" : "Y2hhdGdwdC1icm93c2Vy",
    provider,
    url,
    userCode: null,
    expiresAt: "2026-11-21T09:15:00.000Z",
    interval: 5,
    finish: "code",
  };
}
function status(id: string, value: string, detail: string | null = null) {
  return {
    id,
    provider: "anthropic",
    status: value,
    detail,
    interval: 5,
  } satisfies AiSignInStatus;
}

/**
 * Desktop and the server as one sign-in meets them: each call recorded, each answer the test's.
 * `begin` and `start` throw when given an Error.
 */
function run(options: {
  begin?: Error;
  start: AiSignIn | Error;
  arrival?: RedirectArrival;
  finished?: AiSignInStatus;
}) {
  const calls: string[] = [];
  const ports: (number | undefined)[] = [];
  const finishes: string[] = [];
  let held: string | null = null;
  let live = true;
  const steps: RedirectSteps = {
    begin: async (provider) => {
      calls.push(`begin ${provider}`);
      if (options.begin) throw options.begin;
      return { attemptId: "attempt-1", port: PORT };
    },
    start: async (port) => {
      calls.push("start");
      ports.push(port);
      if (options.start instanceof Error) throw options.start;
      return options.start;
    },
    wait: async (attemptId, state) => {
      calls.push(`wait ${attemptId} ${state}`);
      return options.arrival ?? { code: "the-code", state, error: null };
    },
    cancel: (attemptId) => calls.push(`cancel ${attemptId}`),
    finish: async (signInId, code) => {
      calls.push(`finish ${signInId}`);
      finishes.push(code);
      return options.finished ?? status(signInId, "approved");
    },
    hold: (attemptId) => {
      held = attemptId;
    },
    opened: (signIn) => calls.push(`open ${signIn.url}`),
    current: () => live,
  };
  return {
    steps,
    calls,
    ports,
    finishes,
    held: () => held,
    stop: () => {
      live = false;
    },
  };
}

describe("a sign-in through Desktop", () => {
  test("Claude: port to the server, its page opened, code#state finishes it, nothing pasted", async () => {
    const fake = run({
      start: started(CLAUDE_LOOPBACK, "anthropic"),
      arrival: { code: "Zm9vYmFyLWNvZGU", state: CLAUDE_STATE, error: null },
    });
    expect(await signInThroughDesktop("anthropic", fake.steps)).toEqual({
      outcome: "approved",
    });
    expect(fake.ports).toEqual([PORT]);
    expect(fake.calls).toEqual([
      "begin anthropic",
      "start",
      `open ${CLAUDE_LOOPBACK}`,
      `wait attempt-1 ${CLAUDE_STATE}`,
      "finish Y2xhdWRlLXNpZ24taW4",
    ]);
    expect(fake.finishes).toEqual([`Zm9vYmFyLWNvZGU#${CLAUDE_STATE}`]);
    expect(fake.held()).toBeNull();
  });

  test("ChatGPT: no port sent, the whole address finishes it", async () => {
    const fake = run({
      start: started(CHATGPT_PAGE, "openai"),
      arrival: { code: "ac_ZXhhbXBsZS1jb2Rl", state: "example", error: null },
    });
    expect(await signInThroughDesktop("openai", fake.steps)).toEqual({
      outcome: "approved",
    });
    expect(fake.ports).toEqual([undefined]);
    expect(fake.finishes).toEqual([
      "http://localhost:1455/auth/callback?code=ac_ZXhhbXBsZS1jb2Rl&state=example",
    ]);
  });

  test("an older Desktop, or a port it can't have: the paste, and the server is never asked", async () => {
    const fake = run({
      begin: new Error("Unknown command begin_sign_in_redirect"),
      start: started(CLAUDE_LOOPBACK, "anthropic"),
    });
    expect(await signInThroughDesktop("anthropic", fake.steps)).toEqual({
      outcome: "paste",
      begun: null,
    });
    expect(fake.calls).toEqual(["begin anthropic"]);
  });

  test("a server from before it took the port refuses it (400): Desktop stops listening, and the paste starts again without it", async () => {
    const fake = run({
      start: new ClientError('Unrecognized key: "loopbackPort"', 400),
    });
    expect(await signInThroughDesktop("anthropic", fake.steps)).toEqual({
      outcome: "paste",
      begun: null,
    });
    expect(fake.calls).toEqual([
      "begin anthropic",
      "start",
      "cancel attempt-1",
    ]);
    expect(fake.held()).toBeNull();
  });

  test("any other refusal to start is the sign-in's own failure, said as the server said it", async () => {
    const fake = run({
      start: new ClientError("OpenBot could not start the sign-in.", 422),
    });
    await expect(signInThroughDesktop("anthropic", fake.steps)).rejects.toThrow(
      "OpenBot could not start the sign-in.",
    );
    expect(fake.calls).toEqual([
      "begin anthropic",
      "start",
      "cancel attempt-1",
    ]);
  });

  test("a page that sends the browser somewhere else: Desktop stops listening, and that sign-in is pasted back", async () => {
    const begun = started(CLAUDE_CODE_PAGE, "anthropic");
    const fake = run({ start: begun });
    expect(await signInThroughDesktop("anthropic", fake.steps)).toEqual({
      outcome: "paste",
      begun,
    });
    expect(fake.calls).toEqual([
      "begin anthropic",
      "start",
      "cancel attempt-1",
    ]);
  });

  test("Claude declined: said, and nothing sent to the server", async () => {
    const fake = run({
      start: started(CLAUDE_LOOPBACK, "anthropic"),
      arrival: { code: null, state: CLAUDE_STATE, error: "access_denied" },
    });
    await expect(signInThroughDesktop("anthropic", fake.steps)).rejects.toThrow(
      "The Claude sign-in wasn't approved. Sign in again.",
    );
    expect(fake.finishes).toEqual([]);
  });

  test("the server refused what arrived: its sentence", async () => {
    const fake = run({
      start: started(CLAUDE_LOOPBACK, "anthropic"),
      finished: status(
        "Y2xhdWRlLXNpZ24taW4",
        "failed",
        "Claude didn't approve the sign-in. Sign in again.",
      ),
    });
    await expect(signInThroughDesktop("anthropic", fake.steps)).rejects.toThrow(
      "Claude didn't approve the sign-in. Sign in again.",
    );
  });

  test("no redirect in time: Desktop's sentence, and it stops listening", async () => {
    const fake = run({ start: started(CLAUDE_LOOPBACK, "anthropic") });
    fake.steps.wait = async () => {
      throw new Error("The sign-in took too long. Sign in again.");
    };
    await expect(signInThroughDesktop("anthropic", fake.steps)).rejects.toThrow(
      "The sign-in took too long. Sign in again.",
    );
    expect(fake.calls.at(-1)).toBe("cancel attempt-1");
    expect(fake.held()).toBeNull();
    expect(fake.finishes).toEqual([]);
  });

  test("stopped while it waits: nothing more is sent", async () => {
    const fake = run({ start: started(CLAUDE_LOOPBACK, "anthropic") });
    const wait = fake.steps.wait;
    fake.steps.wait = async (attemptId, state) => {
      fake.stop();
      return wait(attemptId, state);
    };
    expect(await signInThroughDesktop("anthropic", fake.steps)).toEqual({
      outcome: "stopped",
    });
    expect(fake.finishes).toEqual([]);
  });
});
