import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PageFrameStore } from "../src/computer/page-frames";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The frame is taken where the navigation happens.
 *
 * The surface used to capture it after the turn and file it under the tool call, which lost a race it
 * could not win: the same computer is driven by other conversations between the turn ending and the
 * tile asking, and a resumed computer starts blank. So the transcript showed the wrong page, or none.
 *
 * What these cover is the seam that replaced it: navigating photographs the page it just opened, and
 * a screenshot that cannot be taken never fails the navigation the Bot was actually asked to do.
 */

const actor: AuthenticatedActor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
};

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function harness(options?: {
  screenshot?: () => Promise<{ base64: string; url?: string }>;
  navigate?: () => Promise<{ url: string; title: string }>;
  status?: (botId: string) => Promise<{ botId: string; state: string }>;
  isolation?: "per-bot" | "shared";
}) {
  const saved: Array<{
    computerId: string;
    toolCallId: string;
    url: string;
    frame: string;
  }> = [];
  const gateway = {
    provider: { isolation: options?.isolation ?? "per-bot" },
    navigate:
      options?.navigate ??
      (async () => ({
        url: "https://example.com/story",
        title: "A story",
        text: "",
        truncated: false,
        elapsedMs: 1,
      })),
    status:
      options?.status ??
      (async (botId: string) => ({ botId, state: "ready" as const })),
    screenshot:
      options?.screenshot ??
      (async () => ({ base64: "PNGBYTES", url: "https://example.com/story" })),
  } as unknown as ComputerGateway;

  const pageFrames: PageFrameStore = {
    async save(frame) {
      saved.push({
        computerId: frame.computerId,
        toolCallId: frame.toolCallId,
        url: frame.url,
        frame: frame.frame,
      });
    },
    async load(computerId, toolCallId) {
      const found = saved.find(
        (row) => row.computerId === computerId && row.toolCallId === toolCallId,
      );
      return found ? { url: found.url, title: null, frame: found.frame } : null;
    },
    async clear() {
      return saved.splice(0).length;
    },
    async purge() {
      return 0;
    },
  };

  const routes = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    asActor,
    async () => true,
    pageFrames,
  );
  return { routes, saved };
}

function navigate(
  routes: ReturnType<typeof harness>["routes"],
  url: string,
  // `null` means "send no turn at all". `undefined` would take the default, which is the opposite.
  toolCallId: string | null = "call-1",
) {
  return routes.request("http://openbot.test/bot-9/navigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, ...(toolCallId ? { toolCallId } : {}) }),
  });
}

describe("the frame a page was opened on", () => {
  test("navigating keeps a frame of the page it landed on", async () => {
    const { routes, saved } = harness();

    expect((await navigate(routes, "https://example.com/story")).status).toBe(
      200,
    );

    expect(saved).toEqual([
      {
        computerId: "bot-9",
        toolCallId: "call-1",
        url: "https://example.com/story",
        frame: "PNGBYTES",
      },
    ]);
  });

  /*
   * The address the browser ended on, not the one that was asked for. A redirect, a canonical host or
   * an added trailing slash all mean the two differ, and the transcript asks by the page the tool
   * reported, so filing under the request would file under a key nothing ever looks up.
   */
  test("the frame is filed under the page the browser reached", async () => {
    const { routes, saved } = harness({
      navigate: async () => ({
        url: "https://www.example.com/story/",
        title: "A story",
      }),
      screenshot: async () => ({
        base64: "PNGBYTES",
        url: "https://www.example.com/story/",
      }),
    });

    await navigate(routes, "https://example.com/story");

    expect(saved[0]?.url).toBe("https://www.example.com/story/");
  });

  test("the kept frame is read back by the page it was taken of", async () => {
    const { routes } = harness();
    await navigate(routes, "https://example.com/story");

    const response = await routes.request(
      "http://openbot.test/bot-9/page-frame/call-1",
    );

    expect(await response.json()).toEqual({
      frame: {
        url: "https://example.com/story",
        title: null,
        frame: "PNGBYTES",
      },
    });
  });

  test("a turn nobody photographed reads back as no frame", async () => {
    const { routes } = harness();

    const response = await routes.request(
      "http://openbot.test/bot-9/page-frame/call-never",
    );

    expect(await response.json()).toEqual({ frame: null });
  });

  /*
   * The picture is a convenience for reading the conversation back. Failing the navigation the Bot
   * was asked to do because the convenience failed would be the wrong trade every time.
   */
  test("a screenshot that cannot be taken does not fail the navigation", async () => {
    const { routes, saved } = harness({
      screenshot: async () => {
        throw new Error("computer is suspended");
      },
    });

    const response = await navigate(routes, "https://example.com/story");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      url: "https://example.com/story",
    });
    expect(saved).toEqual([]);
  });

  /*
   * The screenshot is a second round trip and nothing holds the browser still between them. With one
   * computer shared by every Bot, another Bot's navigation lands in that gap, and this used to file
   * its page under this turn.
   */
  test("a frame of a different page than the one opened is refused", async () => {
    const { routes, saved } = harness({
      screenshot: async () => ({
        base64: "SOMEBODY-ELSES-PAGE",
        url: "https://payroll.example/salaries",
      }),
    });

    expect((await navigate(routes, "https://example.com/story")).status).toBe(
      200,
    );

    expect(saved).toEqual([]);
  });

  /*
   * A convenience picture must not wake a machine the culler has just put to sleep, nor hold a
   * navigation open for the length of a pod schedule while it does.
   */
  test("a suspended computer is not resumed to photograph it", async () => {
    let asked = false;
    const { routes, saved } = harness({
      status: async (botId: string) => ({ botId, state: "suspended" }),
      screenshot: async () => {
        asked = true;
        return { base64: "PNGBYTES", url: "https://example.com/story" };
      },
    });

    expect((await navigate(routes, "https://example.com/story")).status).toBe(
      200,
    );

    expect(asked).toBe(false);
    expect(saved).toEqual([]);
  });

  /*
   * A computer built before screenshots said which page they were of.
   *
   * Refusing on a missing url did not fail safe, it failed silently and completely: a fleet part-way
   * through a rollout kept no frames at all. With a computer each there is nobody to race with, so
   * the picture can only be this turn's.
   */
  test("an old computer's unlabelled frame is kept when the Bot has its own", async () => {
    const { routes, saved } = harness({
      isolation: "per-bot",
      screenshot: async () => ({ base64: "PNGBYTES" }),
    });

    await navigate(routes, "https://example.com/story");

    expect(saved).toHaveLength(1);
  });

  /* And on one shared browser it cannot be told apart from another Bot's, so it is refused. */
  test("an old computer's unlabelled frame is refused when the computer is shared", async () => {
    const { routes, saved } = harness({
      isolation: "shared",
      screenshot: async () => ({ base64: "PNGBYTES" }),
    });

    await navigate(routes, "https://example.com/story");

    expect(saved).toEqual([]);
  });

  /* A caller that does not know which turn it is still navigates, and simply keeps no frame. */
  test("a navigation with no turn named keeps no frame", async () => {
    const { routes, saved } = harness();

    expect(
      (await navigate(routes, "https://example.com/story", null)).status,
    ).toBe(200);

    expect(saved).toEqual([]);
  });

  /*
   * The store is optional so a deployment can be wired without one. Navigation must not notice.
   */
  test("a deployment keeping no frames still navigates", async () => {
    const gateway = {
      navigate: async () => ({ url: "https://example.com/story", title: "T" }),
      status: async (botId: string) => ({ botId, state: "ready" as const }),
      screenshot: async () => {
        throw new Error("should not be asked");
      },
    } as unknown as ComputerGateway;
    const routes = createComputerRoutes(
      gateway,
      {} as PolicyStore,
      asActor,
      async () => true,
    );

    expect((await navigate(routes, "https://example.com/story")).status).toBe(
      200,
    );
    expect(
      await (
        await routes.request("http://openbot.test/bot-9/page-frame/call-1")
      ).json(),
    ).toEqual({ frame: null });
  });
});
