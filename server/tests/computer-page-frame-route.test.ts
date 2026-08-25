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
  screenshot?: () => Promise<{ base64: string }>;
  navigate?: () => Promise<{ url: string; title: string }>;
}) {
  const saved: Array<{ computerId: string; url: string; frame: string }> = [];
  const gateway = {
    navigate:
      options?.navigate ??
      (async () => ({
        url: "https://example.com/story",
        title: "A story",
        text: "",
        truncated: false,
        elapsedMs: 1,
      })),
    screenshot: options?.screenshot ?? (async () => ({ base64: "PNGBYTES" })),
  } as unknown as ComputerGateway;

  const pageFrames: PageFrameStore = {
    async save(frame) {
      saved.push({
        computerId: frame.computerId,
        url: frame.url,
        frame: frame.frame,
      });
    },
    async load(computerId, url) {
      const found = saved.findLast(
        (row) => row.computerId === computerId && row.url === url,
      );
      return found ? { url: found.url, title: null, frame: found.frame } : null;
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

function navigate(routes: ReturnType<typeof harness>["routes"], url: string) {
  return routes.request("http://openbot.test/bot-9/navigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
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
    });

    await navigate(routes, "https://example.com/story");

    expect(saved[0]?.url).toBe("https://www.example.com/story/");
  });

  test("the kept frame is read back by the page it was taken of", async () => {
    const { routes } = harness();
    await navigate(routes, "https://example.com/story");

    const response = await routes.request(
      `http://openbot.test/bot-9/page-frame?url=${encodeURIComponent("https://example.com/story")}`,
    );

    expect(await response.json()).toEqual({
      frame: {
        url: "https://example.com/story",
        title: null,
        frame: "PNGBYTES",
      },
    });
  });

  test("a page nobody opened reads back as no frame", async () => {
    const { routes } = harness();

    const response = await routes.request(
      "http://openbot.test/bot-9/page-frame?url=https%3A%2F%2Fnever.example",
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
   * The store is optional so a deployment can be wired without one. Navigation must not notice.
   */
  test("a deployment keeping no frames still navigates", async () => {
    const gateway = {
      navigate: async () => ({ url: "https://example.com/story", title: "T" }),
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
        await routes.request("http://openbot.test/bot-9/page-frame?url=x")
      ).json(),
    ).toEqual({ frame: null });
  });
});
