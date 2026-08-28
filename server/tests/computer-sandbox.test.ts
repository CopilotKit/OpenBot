import { describe, expect, test } from "bun:test";
import {
  createSandboxComputerProvider,
  sandboxNameFor,
} from "../src/computer/sandbox";

/**
 * A computer each, as a Sandbox, and the two questions that decide whether it is safe.
 *
 * Which run of a computer this is, because a resumed browser counts generations from one again and a
 * ref from before the suspend must not resolve against the page after it. And whether asking a
 * question can wake a computer, because one that wakes on being asked about never suspends and the
 * bill never falls.
 */
function providerWith(sandbox: unknown, seen: string[] = []) {
  return createSandboxComputerProvider({
    namespace: "openbot",
    template: { podTemplate: { spec: { containers: [] } } },
    idleAfterMs: 60_000,
    apiServer: "https://kubernetes.default",
    token: "t",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return Response.json(sandbox);
    }) as unknown as typeof fetch,
  });
}

const running = (readyAt: string, node: string, ip: string) => ({
  metadata: { name: "bot-knowledge-abc" },
  spec: { operatingMode: "Running" },
  status: {
    serviceFQDN: "bot-knowledge-abc.openbot.svc.cluster.local",
    nodeName: node,
    podIPs: [ip],
    conditions: [
      { type: "Suspended", status: "False" },
      { type: "Ready", status: "True", lastTransitionTime: readyAt },
    ],
  },
});

describe("telling one run of a Bot's computer from the next", () => {
  /*
   * THE CASE A REAL RESUME DISPROVED THE OLD ANSWER WITH.
   *
   * A suspended sandbox is very often rescheduled onto the same node and handed the same address
   * back, because nothing else has taken it. Measured on EKS: both identical across a suspend and
   * resume. Anything built from them says "same run" for the exact case the check exists to catch.
   */
  test("changes across a resume even when the node and address do not", async () => {
    const before = await providerWith(
      running("2026-08-24T23:14:04Z", "node-a", "192.168.49.27"),
    ).sessionOf?.("knowledge");
    const after = await providerWith(
      running("2026-08-25T00:40:04Z", "node-a", "192.168.49.27"),
    ).sessionOf?.("knowledge");

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("is the same while one run keeps serving", async () => {
    const sandbox = running("2026-08-25T00:40:04Z", "node-a", "192.168.49.27");
    expect(await providerWith(sandbox).sessionOf?.("knowledge")).toBe(
      await providerWith(sandbox).sessionOf?.("knowledge"),
    );
  });

  test("a suspended computer has no run to name", async () => {
    // Unknown rather than mismatched: there is no page behind a suspended computer to resolve against.
    const suspended = {
      metadata: { name: "bot-knowledge-abc" },
      spec: { operatingMode: "Suspended" },
      status: { conditions: [{ type: "Suspended", status: "True" }] },
    };
    expect(
      await providerWith(suspended).sessionOf?.("knowledge"),
    ).toBeUndefined();
  });

  test("asking which run it is never starts a computer", async () => {
    /*
     * The invisible way to lose scale-to-zero: everything works, nothing ever suspends, and only the
     * bill says otherwise. Reading is a GET; anything that creates or patches would wake it.
     */
    const seen: string[] = [];
    await providerWith(
      running("2026-08-25T00:40:04Z", "n", "1.2.3.4"),
      seen,
    ).sessionOf?.("knowledge");
    expect(seen.every((call) => call.startsWith("GET "))).toBe(true);
  });

  test("status reads a suspended computer as down and fine, without touching it", async () => {
    const seen: string[] = [];
    const suspended = {
      metadata: { name: "bot-knowledge-abc" },
      spec: { operatingMode: "Suspended" },
      status: { conditions: [{ type: "Suspended", status: "True" }] },
    };
    const status = await providerWith(suspended, seen).status("knowledge");

    expect(status.state).toBe("absent");
    expect(seen.every((call) => call.startsWith("GET "))).toBe(true);
  });
});

describe("naming a Bot's computer in a cluster", () => {
  test("a bot id that is not a legal name still gets one, and a unique one", () => {
    // Bot ids are ours and hold anything a person typed; a resource name may not. Two ids that differ
    // only in punctuation must not land on one computer, which would be one Bot reading another's
    // logins.
    const a = sandboxNameFor("Sales Bot");
    const b = sandboxNameFor("sales-bot");
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(b).toMatch(/^[a-z0-9-]+$/);
    expect(a).not.toBe(b);
  });

  test("the same id always names the same computer", () => {
    expect(sandboxNameFor("knowledge")).toBe(sandboxNameFor("knowledge"));
  });
});

/**
 * A projected service account token is not a constant.
 *
 * The kubelet rewrites the file well before the token expires, and how long that is belongs to the
 * cluster: an hour where somebody hardened it, a day by default. Read once and held for the life of
 * the process, sandbox calls work right up to the first rotation and then every one returns 401,
 * which reads like the cluster broke rather than like a credential going stale.
 */
describe("the credential a sandbox call carries", () => {
  test("is asked for again rather than captured once", async () => {
    const sent: string[] = [];
    let current = "first";
    const provider = createSandboxComputerProvider({
      namespace: "openbot",
      idleAfterMs: 60_000,
      template: { podTemplate: {} },
      apiServer: "https://cluster.test",
      token: async () => current,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push(
          String((init.headers as Record<string, string>).authorization),
        );
        return new Response("null", { status: 404 });
      }) as unknown as typeof fetch,
    });

    await provider.status("bot-1");
    current = "rotated";
    await provider.status("bot-1");

    expect(sent).toEqual(["Bearer first", "Bearer rotated"]);
  });
});
