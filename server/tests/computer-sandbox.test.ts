import { describe, expect, test } from "bun:test";
import { ComputerStillStartingError } from "../src/computer/client";
import { botSeat, personSeat } from "../src/computer/computer-key";
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
    ).sessionOf?.(botSeat("knowledge"));
    const after = await providerWith(
      running("2026-08-25T00:40:04Z", "node-a", "192.168.49.27"),
    ).sessionOf?.(botSeat("knowledge"));

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("is the same while one run keeps serving", async () => {
    const sandbox = running("2026-08-25T00:40:04Z", "node-a", "192.168.49.27");
    expect(await providerWith(sandbox).sessionOf?.(botSeat("knowledge"))).toBe(
      await providerWith(sandbox).sessionOf?.(botSeat("knowledge")),
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
      await providerWith(suspended).sessionOf?.(botSeat("knowledge")),
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
    ).sessionOf?.(botSeat("knowledge"));
    expect(seen.every((call) => call.startsWith("GET "))).toBe(true);
  });

  test("status reads a suspended computer as down and fine, without touching it", async () => {
    const seen: string[] = [];
    const suspended = {
      metadata: { name: "bot-knowledge-abc" },
      spec: { operatingMode: "Suspended" },
      status: { conditions: [{ type: "Suspended", status: "True" }] },
    };
    const status = await providerWith(suspended, seen).status(
      botSeat("knowledge"),
    );

    expect(status.state).toBe("absent");
    expect(seen.every((call) => call.startsWith("GET "))).toBe(true);
  });
});

/**
 * A cold start that runs past the wait is a wait, not a fault.
 *
 * It used to throw a `SandboxError` whose message explained the pod schedule to whoever was
 * watching, and the route answered 500. Now it is the typed "still starting" every surface knows to
 * render gently, and the call it interrupted is said to have done nothing.
 */
describe("a computer that takes longer than the wait to start", () => {
  const booting = {
    metadata: { name: "bot-general-abc" },
    spec: { operatingMode: "Running" },
    status: {
      conditions: [
        { type: "Suspended", status: "False" },
        { type: "Ready", status: "False" },
      ],
    },
  };

  test("locate gives up with the still-starting error, not a sandbox failure", async () => {
    const provider = createSandboxComputerProvider({
      namespace: "openbot",
      template: { podTemplate: { spec: { containers: [] } } },
      idleAfterMs: 60_000,
      apiServer: "https://kubernetes.default",
      token: "t",
      resumeTimeoutMs: 0,
      fetchImpl: (async () =>
        Response.json(booting)) as unknown as typeof fetch,
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const failure = await provider
        .locate(botSeat("general"))
        .catch((error) => error);
      expect(failure).toBeInstanceOf(ComputerStillStartingError);
      expect(failure.message).toContain("not performed");
    } finally {
      console.warn = warn;
    }
  });

  test("locate answers within its own wait, well before a resume's budget runs out", async () => {
    // Held under a load balancer's idle timeout, so the person's request is answered, not cut.
    const provider = createSandboxComputerProvider({
      namespace: "openbot",
      template: { podTemplate: { spec: { containers: [] } } },
      idleAfterMs: 60_000,
      apiServer: "https://kubernetes.default",
      token: "t",
      resumeTimeoutMs: 600_000,
      locateWaitMs: 0,
      fetchImpl: (async () =>
        Response.json(booting)) as unknown as typeof fetch,
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const failure = await provider
        .locate(botSeat("general"))
        .catch((error) => error);
      expect(failure).toBeInstanceOf(ComputerStillStartingError);
    } finally {
      console.warn = warn;
    }
  });

  test("status calls one on its way up starting, without touching it", async () => {
    const seen: string[] = [];
    const status = await providerWith(booting, seen).status(botSeat("general"));
    expect(status.state).toBe("starting");
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

    await provider.status(botSeat("bot-1"));
    current = "rotated";
    await provider.status(botSeat("bot-1"));

    expect(sent).toEqual(["Bearer first", "Bearer rotated"]);
  });
});

/**
 * A computer keeping up with the deployment's image.
 *
 * A Sandbox carries its pod template inline, and the agent-sandbox controller cuts a pod from it
 * only when there is none: an existing pod's spec is left alone (v0.5.6, `reconcilePod`). So a
 * computer created before an upgrade ran its old image for ever, and new computer code never reached
 * it. The fake below is that controller in miniature: a pod is created from the template on
 * Running when none exists, deleted on Suspended, and never changed while it runs.
 */
const IMAGE = (tag: string) => ({
  spec: { containers: [{ name: "computer", image: `openbot:${tag}` }] },
});

function fakeCluster(initial: {
  mode: "Running" | "Suspended";
  image: string;
  volumes?: unknown;
}) {
  const state = {
    generation: 1,
    mode: initial.mode,
    podTemplate: IMAGE(initial.image) as unknown,
    volumeClaimTemplates: initial.volumes ?? [
      { metadata: { name: "profile" } },
    ],
    /** The image the pod is running, or undefined when there is no pod. */
    pod: initial.mode === "Running" ? initial.image : undefined,
    readyAt: "2026-09-29T00:00:00Z",
  };
  const patches: { contentType: string; body: unknown }[] = [];
  const imageOf = (template: unknown) =>
    (template as ReturnType<typeof IMAGE>).spec.containers[0]?.image.replace(
      "openbot:",
      "",
    );
  // What the controller would do on its next reconcile.
  const reconcile = () => {
    if (state.mode === "Suspended") state.pod = undefined;
    else if (!state.pod) {
      state.pod = imageOf(state.podTemplate);
      state.readyAt = new Date().toISOString();
    }
  };
  const body = () => ({
    metadata: { name: "bot-general-abc", generation: state.generation },
    spec: {
      operatingMode: state.mode,
      podTemplate: state.podTemplate,
      volumeClaimTemplates: state.volumeClaimTemplates,
    },
    status: {
      serviceFQDN: "bot-general-abc.openbot.svc.cluster.local",
      conditions: [
        {
          type: "Suspended",
          status: state.mode === "Suspended" && !state.pod ? "True" : "False",
          observedGeneration: state.generation,
        },
        {
          type: "Ready",
          status: state.pod ? "True" : "False",
          lastTransitionTime: state.readyAt,
        },
      ],
    },
  });
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PATCH") {
      const contentType = String(
        (init?.headers as Record<string, string> | undefined)?.["content-type"],
      );
      const patch = JSON.parse(String(init?.body));
      patches.push({ contentType, body: patch });
      if (contentType === "application/json-patch+json") {
        for (const op of patch as { path: string; value: unknown }[]) {
          if (op.path === "/spec/podTemplate") state.podTemplate = op.value;
          else if (op.path === "/spec/operatingMode")
            state.mode = op.value as "Running" | "Suspended";
          else if (op.path.startsWith("/spec/volumeClaimTemplates"))
            return new Response("volumeClaimTemplates is immutable", {
              status: 422,
            });
        }
      } else if (patch.spec?.operatingMode) {
        state.mode = patch.spec.operatingMode;
      }
      state.generation += 1;
      const answer = body();
      reconcile();
      return Response.json(answer);
    }
    reconcile();
    // The collection, for `list`; one Sandbox by name for everything else.
    return new URL(_url).pathname.endsWith("/sandboxes")
      ? Response.json({ items: [body()] })
      : Response.json(body());
  }) as unknown as typeof fetch;
  return { state, patches, fetchImpl };
}

function providerOn(cluster: ReturnType<typeof fakeCluster>, tag: string) {
  return createSandboxComputerProvider({
    namespace: "openbot",
    template: {
      podTemplate: IMAGE(tag),
      volumeClaimTemplates: [{ metadata: { name: "profile" } }],
    },
    idleAfterMs: 60_000,
    apiServer: "https://kubernetes.default",
    token: "t",
    resumeTimeoutMs: 5_000,
    fetchImpl: cluster.fetchImpl,
  });
}

describe("a computer on an older image", () => {
  test("waking it from suspended brings it onto the current image, volumes untouched", async () => {
    const cluster = fakeCluster({ mode: "Suspended", image: "old" });
    const volumes = cluster.state.volumeClaimTemplates;

    await providerOn(cluster, "new").locate(botSeat("general"));

    expect(cluster.state.pod).toBe("new");
    expect(cluster.state.mode).toBe("Running");
    // The profile and workspace claims are the same object: nothing wrote to them.
    expect(cluster.state.volumeClaimTemplates).toBe(volumes);
    // One write, with the template and the mode together, so the pod is never cut from the old one.
    expect(cluster.patches).toHaveLength(1);
    const ops = cluster.patches[0]?.body as { path: string }[];
    expect(ops.map((op) => op.path).sort()).toEqual([
      "/spec/operatingMode",
      "/spec/podTemplate",
    ]);
  });

  test("waking one that is already current changes only its mode", async () => {
    const cluster = fakeCluster({ mode: "Suspended", image: "same" });
    await providerOn(cluster, "same").locate(botSeat("general"));
    expect(cluster.patches).toEqual([
      {
        contentType: "application/merge-patch+json",
        body: { spec: { operatingMode: "Running" } },
      },
    ]);
  });

  test("one that is running mid-task is never restarted by being used", async () => {
    const cluster = fakeCluster({ mode: "Running", image: "old" });
    await providerOn(cluster, "new").locate(botSeat("general"));
    expect(cluster.patches).toHaveLength(0);
    expect(cluster.state.pod).toBe("old");
  });

  test("the list says which computers are out of date", async () => {
    const cluster = fakeCluster({ mode: "Running", image: "old" });
    const [stale] = await providerOn(cluster, "new").list();
    expect(stale?.updateAvailable).toBe(true);
    const [current] = await providerOn(cluster, "old").list();
    expect(current?.updateAvailable).toBe(false);
  });
});

describe("which id a computer is for", () => {
  /*
   * A computer of one id (a person's own browser, an isolated Bot) has to know it: it runs a person's browser only on a
   * computer of its own (agent-computer's person-access.ts), and without `COMPUTER_BOT_ID` it reads as a computer Bots
   * share and refuses. A person's computer carries several Bots and names none. Told on creation and on every new
   * template, as the supervisor tells each container.
   */
  const PERSON = "person-0123456789abcdef0123456789abcdef";
  const envOf = (template: unknown) =>
    (
      template as {
        spec: { containers: { env?: { name: string; value?: string }[] }[] };
      }
    ).spec.containers[0]?.env;

  test("a new computer's pod says the id it was made for", async () => {
    const created: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        created.push(JSON.parse(String(init.body)));
        return Response.json({});
      }
      if (created.length === 0) return new Response("", { status: 404 });
      return Response.json(running("2026-10-27T00:00:00Z", "n", "1.2.3.4"));
    }) as unknown as typeof fetch;
    const template = {
      spec: {
        containers: [
          {
            name: "computer",
            image: "openbot:new",
            env: [
              { name: "PORT", value: "4100" },
              // One the template carried is replaced, never doubled.
              { name: "COMPUTER_BOT_ID", value: "shared" },
            ],
          },
        ],
      },
    };
    await createSandboxComputerProvider({
      namespace: "openbot",
      template: { podTemplate: template },
      idleAfterMs: 60_000,
      apiServer: "https://kubernetes.default",
      token: "t",
      fetchImpl,
    }).locate(botSeat(PERSON));
    const body = created[0] as { spec: { podTemplate: unknown } };
    expect(envOf(body.spec.podTemplate)).toEqual([
      { name: "PORT", value: "4100" },
      { name: "COMPUTER_BOT_ID", value: PERSON },
      { name: "COMPUTER_SEPARATE_WORKSPACES", value: "off" },
    ]);
    // The template every computer is cut from is left as it was.
    expect(template.spec.containers[0]?.env).toHaveLength(2);
    expect(template.spec.containers[0]?.env[1]?.value).toBe("shared");
  });

  test("a computer brought onto a new image keeps being told", async () => {
    const cluster = fakeCluster({ mode: "Suspended", image: "old" });
    await providerOn(cluster, "new").locate(botSeat(PERSON));
    expect(envOf(cluster.state.podTemplate)).toEqual([
      { name: "COMPUTER_BOT_ID", value: PERSON },
      { name: "COMPUTER_SEPARATE_WORKSPACES", value: "off" },
    ]);
    // An id is no reason to call a computer out of date: only its image is.
    const [current] = await providerOn(cluster, "new").list();
    expect(current?.updateAvailable).toBe(false);
  });
});

describe("where a computer keeps its files", () => {
  const envOf = (template: unknown) =>
    (
      template as {
        spec: { containers: { env?: { name: string; value?: string }[] }[] };
      }
    ).spec.containers[0]?.env;
  /** The chart's template, which gives every Bot a folder of its own. */
  const separated = (tag: string) => ({
    spec: {
      containers: [
        {
          name: "computer",
          image: `openbot:${tag}`,
          env: [{ name: "COMPUTER_SEPARATE_WORKSPACES", value: "on" }],
        },
      ],
    },
  });

  test("an isolated Bot brought onto a new image keeps its files at the root of the volume it had", async () => {
    // The Sandbox its Bot had before computers were per person, named for the Bot, with its files at the root.
    const cluster = fakeCluster({ mode: "Suspended", image: "old" });
    await createSandboxComputerProvider({
      namespace: "openbot",
      template: {
        podTemplate: separated("new"),
        volumeClaimTemplates: [{ metadata: { name: "profile" } }],
      },
      idleAfterMs: 60_000,
      apiServer: "https://kubernetes.default",
      token: "t",
      fetchImpl: cluster.fetchImpl,
    }).locate(botSeat("general"));
    expect(envOf(cluster.state.podTemplate)).toEqual([
      { name: "COMPUTER_BOT_ID", value: "general" },
      { name: "COMPUTER_SEPARATE_WORKSPACES", value: "off" },
    ]);
  });

  test("a person's computer gives each Bot a folder, names no Bot, and is told whose it is", async () => {
    const cluster = fakeCluster({ mode: "Suspended", image: "old" });
    await createSandboxComputerProvider({
      namespace: "openbot",
      template: {
        podTemplate: {
          spec: {
            containers: [
              {
                name: "computer",
                image: "openbot:new",
                env: [{ name: "COMPUTER_BOT_ID", value: "stray" }],
              },
            ],
          },
        },
        volumeClaimTemplates: [{ metadata: { name: "profile" } }],
      },
      idleAfterMs: 60_000,
      apiServer: "https://kubernetes.default",
      token: "t",
      fetchImpl: cluster.fetchImpl,
    }).locate(personSeat("user-1", "general"));
    expect(envOf(cluster.state.podTemplate)).toEqual([
      { name: "COMPUTER_PERSON_ID", value: "user-1" },
      { name: "COMPUTER_SEPARATE_WORKSPACES", value: "on" },
    ]);
  });
});

describe("updating a computer on request", () => {
  test("a running one restarts on the new image and keeps its volumes", async () => {
    const cluster = fakeCluster({ mode: "Running", image: "old" });
    const volumes = cluster.state.volumeClaimTemplates;
    const provider = providerOn(cluster, "new");

    const result = await provider.update(botSeat("general").key);
    expect(result).toMatchObject({ updated: true, wasRunning: true });
    await provider.restarting(botSeat("general").key);

    expect(cluster.state.pod).toBe("new");
    expect(cluster.state.mode).toBe("Running");
    expect(cluster.state.volumeClaimTemplates).toBe(volumes);
    // Suspended with the new template, then resumed: the only way the controller replaces a pod.
    const modes = cluster.patches.map((patch) =>
      patch.contentType === "application/json-patch+json"
        ? (patch.body as { path: string; value: unknown }[]).find(
            (op) => op.path === "/spec/operatingMode",
          )?.value
        : (patch.body as { spec: { operatingMode: string } }).spec
            .operatingMode,
    );
    expect(modes).toEqual(["Suspended", "Running"]);
  });

  test("a suspended one takes the new template and stays asleep", async () => {
    const cluster = fakeCluster({ mode: "Suspended", image: "old" });
    const provider = providerOn(cluster, "new");

    expect(await provider.update(botSeat("general").key)).toMatchObject({
      updated: true,
      wasRunning: false,
    });
    expect(provider.restarting(botSeat("general").key)).toBeUndefined();
    expect(cluster.state.mode).toBe("Suspended");
    expect(cluster.state.pod).toBeUndefined();

    // And the next use wakes it on the new image without a second template write.
    await provider.locate(botSeat("general"));
    expect(cluster.state.pod).toBe("new");
  });

  test("one already on the current image is left alone", async () => {
    const cluster = fakeCluster({ mode: "Running", image: "same" });
    expect(
      await providerOn(cluster, "same").update(botSeat("general").key),
    ).toMatchObject({
      updated: false,
    });
    expect(cluster.patches).toHaveLength(0);
  });

  test("a Bot with no computer has nothing to update", async () => {
    const provider = createSandboxComputerProvider({
      namespace: "openbot",
      template: { podTemplate: IMAGE("new") },
      idleAfterMs: 60_000,
      apiServer: "https://kubernetes.default",
      token: "t",
      fetchImpl: (async () =>
        new Response("null", { status: 404 })) as unknown as typeof fetch,
    });
    expect(await provider.update(botSeat("general").key)).toEqual({
      updated: false,
      wasRunning: false,
    });
  });
});

/**
 * One Sandbox per person, and per isolated Bot.
 *
 * The regression: a Sandbox was named for the Bot alone, so a public Bot's one Sandbox, and the
 * logins in its volume, were everybody's.
 */
describe("whose computer a Sandbox is", () => {
  test("two people on one public Bot get two Sandboxes", () => {
    const ada = sandboxNameFor(personSeat("ada", "pub-bot").key);
    const bo = sandboxNameFor(personSeat("bo", "pub-bot").key);
    expect(ada).not.toBe(bo);
    expect(ada.startsWith("person-")).toBe(true);
  });

  test("one person's two Bots share that person's Sandbox", () => {
    expect(sandboxNameFor(personSeat("ada", "sales").key)).toBe(
      sandboxNameFor(personSeat("ada", "notes").key),
    );
  });

  test("an isolated Bot keeps the Sandbox every Bot's computer had before", () => {
    // Same name as before computers were per person, so its existing volume and logins carry on.
    expect(sandboxNameFor(botSeat("knowledge").key)).toBe(
      sandboxNameFor("knowledge"),
    );
    expect(sandboxNameFor({ kind: "person", personId: "knowledge" })).not.toBe(
      sandboxNameFor("knowledge"),
    );
  });

  test("a person's Sandbox is created for them, and listed as theirs", async () => {
    const created: unknown[] = [];
    let exists = false;
    const provider = createSandboxComputerProvider({
      namespace: "openbot",
      template: { podTemplate: { spec: { containers: [] } } },
      idleAfterMs: 60_000,
      apiServer: "https://kubernetes.default",
      token: "t",
      locateWaitMs: 50,
      resumeTimeoutMs: 50,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          created.push(JSON.parse(String(init?.body)));
          exists = true;
          return Response.json({});
        }
        if (new URL(String(url)).pathname.endsWith("/sandboxes")) {
          return Response.json({ items: created });
        }
        if (!exists) return new Response("", { status: 404 });
        return Response.json({
          ...(created[0] as object),
          status: {
            serviceFQDN: "person-ada.openbot.svc.cluster.local",
            conditions: [{ type: "Ready", status: "True" }],
          },
        });
      }) as unknown as typeof fetch,
    });

    expect(await provider.locate(personSeat("ada", "sales"))).toBe(
      "http://person-ada.openbot.svc.cluster.local:4100",
    );
    expect(created).toHaveLength(1);
    expect(
      (created[0] as { metadata: { annotations: Record<string, string> } })
        .metadata.annotations,
    ).toEqual({
      "openbot.dev/person-id": "ada",
      "openbot.dev/computer": "person:ada",
    });
    // A second Bot of Ada's reaches the same Sandbox and creates nothing.
    await provider.locate(personSeat("ada", "notes"));
    expect(created).toHaveLength(1);
    expect((await provider.list()).map((computer) => computer.key)).toEqual([
      { kind: "person", personId: "ada" },
    ]);
  });
});
