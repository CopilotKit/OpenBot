import { describe, expect, test } from "bun:test";
import type { ComputerProvider } from "../src/computer/provider";
import {
  createDockerSupervisorProvider,
  SupervisorError,
} from "../src/computer/supervisor";

/**
 * Asking the supervisor where a Bot's computer is.
 *
 * The interesting cases are all failures, because the success case is a URL. What matters is that a
 * computer nobody can reach is an error rather than a quiet fallback: a client that shrugged and used
 * the shared address would put one Bot on another Bot's computer, which is the exact thing a supervisor exists
 * to prevent, and it would look like it was working.
 */

function clientWith(handler: (path: string) => Response): ComputerProvider {
  return createDockerSupervisorProvider({
    baseUrl: "http://supervisor:4300",
    token: "t",
    fetchImpl: (async (url: string | URL | Request) =>
      handler(new URL(String(url)).pathname)) as unknown as typeof fetch,
  });
}

describe("locating a Bot's computer", () => {
  test("uses the address the supervisor reports", async () => {
    const client = clientWith(() =>
      Response.json({
        botId: "sales",
        container: "openbot-computer-sales",
        status: "running",
        url: "http://openbot-computer-sales:4100",
      }),
    );
    expect(await client.locate("sales")).toBe(
      "http://openbot-computer-sales:4100",
    );
  });

  test("falls back to a published port when there is no name to use", async () => {
    // A laptop: the server runs outside Docker, so the only way in is the published port.
    const client = clientWith(() =>
      Response.json({
        botId: "sales",
        container: "openbot-computer-sales",
        status: "running",
        port: 49213,
      }),
    );
    expect(await client.locate("sales")).toBe("http://localhost:49213");
  });

  test("a computer with no address at all is an error, not a fallback", async () => {
    const client = clientWith(() =>
      Response.json({
        botId: "sales",
        container: "openbot-computer-sales",
        status: "running",
      }),
    );
    expect(client.locate("sales")).rejects.toThrow(SupervisorError);
  });

  test("a refusal from the supervisor is reported in its own words", async () => {
    const client = clientWith(() =>
      Response.json(
        { error: "A bot id may contain only letters." },
        { status: 400 },
      ),
    );
    expect(client.locate("bad id")).rejects.toThrow(
      "A bot id may contain only letters.",
    );
  });

  test("an unreachable supervisor says so, rather than looking like a broken computer", async () => {
    // These are different problems for whoever has to fix them: one is the supervisor, the other is
    // the Bot's own container.
    const client = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    expect(client.locate("sales")).rejects.toThrow(/could not be reached/);
  });

  test("the bot id is escaped into the path", async () => {
    let seen = "";
    const client = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async (url: string | URL | Request) => {
        seen = new URL(String(url)).pathname;
        return Response.json({ url: "http://c:4100" });
      }) as unknown as typeof fetch,
    });
    await client.locate("a/b");
    expect(seen).toBe("/computers/a%2Fb/ensure");
  });
});

describe("Docker supervisor provider", () => {
  test("describes one container and browser profile for each Bot", () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ computers: [] })) as unknown as typeof fetch,
    });

    expect(provider.name).toBe("Docker supervisor");
    expect(provider.isolation).toBe("per-bot");
  });

  test.each([
    ["created", { botId: "bot", state: "starting" }],
    ["running", { botId: "bot", state: "ready" }],
    ["paused", { botId: "bot", state: "absent" }],
    ["restarting", { botId: "bot", state: "starting" }],
    ["removing", { botId: "bot", state: "absent" }],
    ["exited", { botId: "bot", state: "absent" }],
    ["dead", { botId: "bot", state: "unreachable" }],
  ] as const)(
    "maps Docker container status %s to lifecycle state",
    async (dockerStatus, expected) => {
      const provider = createDockerSupervisorProvider({
        baseUrl: "http://supervisor:4300",
        fetchImpl: (async () =>
          Response.json({
            computers: [
              {
                botId: "bot",
                container: "openbot-computer-bot",
                status: dockerStatus,
                url: "http://openbot-computer-bot:4100",
              },
            ],
          })) as unknown as typeof fetch,
      });

      const result = await provider.status("bot");
      expect(result).toMatchObject(expected);
    },
  );

  test("reports missing bot as absent", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ computers: [] })) as unknown as typeof fetch,
    });

    expect(await provider.status("missing-bot")).toEqual({
      botId: "missing-bot",
      state: "absent",
    });
  });

  test("lists only the provider location fields with mapped status", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({
          computers: [
            {
              botId: "sales",
              container: "computer-sales",
              status: "running",
              port: 49152,
              url: "http://computer-sales:4100",
              startedAt: "2026-08-20T12:00:00.000Z",
            },
            {
              botId: "support",
              container: "computer-support",
              status: "exited",
              port: 49153,
              url: "http://computer-support:4100",
            },
          ],
        })) as unknown as typeof fetch,
    });

    expect(await provider.list()).toEqual([
      {
        botId: "sales",
        status: "running",
        url: "http://computer-sales:4100",
        startedAt: "2026-08-20T12:00:00.000Z",
      },
      {
        botId: "support",
        status: "stopped",
        url: "http://computer-support:4100",
      },
    ]);
  });

  test("stop reports whether the container was running", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ stopped: true })) as unknown as typeof fetch,
    });

    expect(await provider.stop("bot")).toEqual({ wasRunning: true });
  });

  test("stop reports false when container was not running", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ stopped: false })) as unknown as typeof fetch,
    });

    expect(await provider.stop("bot")).toEqual({ wasRunning: false });
  });

  test("reset reports whether container state was cleared", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ reset: true })) as unknown as typeof fetch,
    });

    expect(await provider.reset("bot")).toEqual({ cleared: true });
  });

  test("reset reports false when container was not present to clear", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ reset: false })) as unknown as typeof fetch,
    });

    expect(await provider.reset("bot")).toEqual({ cleared: false });
  });
});
