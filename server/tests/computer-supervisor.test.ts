import { describe, expect, test } from "bun:test";
import { ComputerStillStartingError } from "../src/computer/client";
import { botSeat, personSeat } from "../src/computer/computer-key";
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
        kind: "bot",
        id: "sales",
        container: "openbot-computer-sales",
        status: "running",
        url: "http://openbot-computer-sales:4100",
      }),
    );
    expect(await client.locate(botSeat("sales"))).toBe(
      "http://openbot-computer-sales:4100",
    );
  });

  test("falls back to a published port when there is no name to use", async () => {
    // A laptop: the server runs outside Docker, so the only way in is the published port.
    const client = clientWith(() =>
      Response.json({
        kind: "bot",
        id: "sales",
        container: "openbot-computer-sales",
        status: "running",
        port: 49213,
      }),
    );
    // Numeric, never `localhost`: it resolves to a different interface depending on the
    // runtime, so a computer that is listening can look like one that is not.
    expect(await client.locate(botSeat("sales"))).toBe(
      "http://127.0.0.1:49213",
    );
  });

  test("a computer with no address at all is an error, not a fallback", async () => {
    const client = clientWith(() =>
      Response.json({
        kind: "bot",
        id: "sales",
        container: "openbot-computer-sales",
        status: "running",
      }),
    );
    expect(client.locate(botSeat("sales"))).rejects.toThrow(SupervisorError);
  });

  test("a refusal from the supervisor is reported in its own words", async () => {
    const client = clientWith(() =>
      Response.json(
        { error: "A bot id may contain only letters." },
        { status: 400 },
      ),
    );
    expect(client.locate(botSeat("bad id"))).rejects.toThrow(
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
    expect(client.locate(botSeat("sales"))).rejects.toThrow(
      /could not be reached/,
    );
  });

  test("an ensure that runs out of time is a computer still starting, not a broken supervisor", async () => {
    // `/ensure` is the call that waits on a container coming up, so its deadline is a slow start.
    const client = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as unknown as typeof fetch,
    });
    const failure = await client
      .locate(botSeat("sales"))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ComputerStillStartingError);
  });

  test("a timeout on a plain read is still the supervisor's fault", async () => {
    const client = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as unknown as typeof fetch,
    });
    await expect(client.stop({ key: botSeat("sales").key })).rejects.toThrow(
      SupervisorError,
    );
  });

  test("an ensure the supervisor answers as still booting is a computer still starting", async () => {
    // The supervisor's own health wait ran out on a container that is up, and it says so.
    const client = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json(
          {
            error: "The computer started but did not answer within 60000ms.",
            starting: true,
          },
          { status: 503 },
        )) as unknown as typeof fetch,
    });
    const failure = await client
      .locate(botSeat("sales"))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ComputerStillStartingError);
  });

  test("a 503 from an unreachable Docker is still the supervisor's fault", async () => {
    const client = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json(
          { error: "Docker is not reachable." },
          { status: 503 },
        )) as unknown as typeof fetch,
    });
    const failure = await client
      .locate(botSeat("sales"))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(SupervisorError);
    expect(failure).not.toBeInstanceOf(ComputerStillStartingError);
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
    await client.locate(botSeat("a/b"));
    expect(seen).toBe("/computers/bot/a%2Fb/ensure");
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
    expect(provider.isolation).toBe("per-person");
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
                kind: "bot",
                id: "bot",
                container: "openbot-computer-bot",
                status: dockerStatus,
                url: "http://openbot-computer-bot:4100",
              },
            ],
          })) as unknown as typeof fetch,
      });

      const result = await provider.status(botSeat("bot"));
      expect(result).toMatchObject(expected);
    },
  );

  test("a running container whose healthcheck is still starting is starting, not ready", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({
          computers: [
            { kind: "bot", id: "bot", status: "running", health: "starting" },
            { kind: "bot", id: "other", status: "running", health: "healthy" },
          ],
        })) as unknown as typeof fetch,
    });

    expect(await provider.status(botSeat("bot"))).toEqual({
      botId: "bot",
      state: "starting",
    });
    expect(await provider.status(botSeat("other"))).toEqual({
      botId: "other",
      state: "ready",
    });
  });

  test("reports missing bot as absent", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ computers: [] })) as unknown as typeof fetch,
    });

    expect(await provider.status(botSeat("missing-bot"))).toEqual({
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
              kind: "bot",
              id: "sales",
              container: "computer-sales",
              status: "running",
              port: 49152,
              url: "http://computer-sales:4100",
              startedAt: "2026-08-20T12:00:00.000Z",
            },
            {
              kind: "bot",
              id: "support",
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
        key: { kind: "bot", botId: "sales" },
        status: "running",
        url: "http://computer-sales:4100",
        startedAt: "2026-08-20T12:00:00.000Z",
      },
      {
        key: { kind: "bot", botId: "support" },
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

    expect(await provider.stop({ key: botSeat("bot").key })).toEqual({
      wasRunning: true,
    });
  });

  test("stop reports false when container was not running", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ stopped: false })) as unknown as typeof fetch,
    });

    expect(await provider.stop({ key: botSeat("bot").key })).toEqual({
      wasRunning: false,
    });
  });

  test("reset reports whether container state was cleared", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ reset: true })) as unknown as typeof fetch,
    });

    expect(await provider.reset({ key: botSeat("bot").key })).toEqual({
      cleared: true,
    });
  });

  test("reset reports false when container was not present to clear", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({ reset: false })) as unknown as typeof fetch,
    });

    expect(await provider.reset({ key: botSeat("bot").key })).toEqual({
      cleared: false,
    });
  });
});

/**
 * Which run of a computer this is, asked by a replica that did not start it.
 *
 * `sessionOf` is what stops a ref from a dead container resolving against a live one: a replaced
 * computer counts generations from one again, so the generation alone cannot tell them apart. It
 * answers from what the last `/ensure` reported, which is free and correct while one process does
 * both halves of the work.
 *
 * On more than one replica it is neither. The replica that took the snapshot is very often not the
 * replica handling the click, and the second one has never called `/ensure` for that Bot, so it has
 * nothing to answer with. `resolve` treats an unknown session as "no opinion" and skips the check by
 * design, which is right for a provider that cannot tell and wrong here: the check is simply absent,
 * silently, on exactly the deployment shape it was written for.
 */
describe("telling one run of a computer from the next, across replicas", () => {
  /*
   * A bot id of its own per test, because the map this reads is module scope.
   *
   * Two providers in one process are not two replicas: they share it. A test that located the
   * computer under one name and then asked under the same name would pass whatever the code did,
   * which is the shape of a test that proves nothing.
   */
  const startedAt = "2026-08-24T09:00:00.000Z";

  function replica(botId: string, seen: string[] = []) {
    const running = [
      {
        kind: "bot",
        id: botId,
        container: `openbot-computer-${botId}`,
        status: "running",
        url: `http://openbot-computer-${botId}:4100`,
        startedAt,
      },
    ];
    return createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      token: "t",
      fetchImpl: (async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        seen.push(path);
        if (path.endsWith("/ensure")) return Response.json(running[0]);
        return Response.json({ computers: running });
      }) as unknown as typeof fetch,
    });
  }

  test("a replica that located the computer knows the run", async () => {
    const client = replica("located");
    await client.locate(botSeat("located"));
    expect(await client.sessionOf?.(botSeat("located"))).toBe(startedAt);
  });

  test("a replica that never located it still knows the run", async () => {
    /*
     * The regression. This replica is serving the click; another one took the snapshot. Without an
     * answer here the generation check is skipped and a ref from a computer that has since been
     * replaced resolves against the new one, which is the case the check exists for.
     */
    const client = replica("never-located");
    expect(await client.sessionOf?.(botSeat("never-located"))).toBe(startedAt);
  });

  test("asking does not start a computer that is not running", async () => {
    /*
     * The other half, and the easier one to get wrong. `/ensure` starts a computer; answering this
     * question with it would mean every idle Bot is woken by being asked about, which is how a
     * deployment ends up never suspending anything and never noticing, because everything works and
     * only the bill says otherwise.
     */
    const seen: string[] = [];
    const client = replica("asked-about", seen);
    await client.sessionOf?.(botSeat("asked-about"));
    expect(seen.some((path) => path.endsWith("/ensure"))).toBe(false);
  });
});

/**
 * One computer per person, asked of the supervisor by whose it is.
 *
 * The regression: every Bot was a container of its own, keyed by the Bot alone, so a public Bot's
 * one container (and its logins) was shared by everybody who used it.
 */
describe("whose computer the supervisor is asked for", () => {
  function recording() {
    const asked: { path: string; body: unknown }[] = [];
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        asked.push({ path, body });
        const bots = (body as { carryOver?: string[] } | undefined)?.carryOver;
        return Response.json({
          url: `http://c${path.replaceAll("/", "-")}:4100`,
          ...(bots
            ? {
                carriedOver: Object.fromEntries(bots.map((b) => [b, "copied"])),
              }
            : {}),
        });
      }) as unknown as typeof fetch,
    });
    return { provider, asked };
  }

  test("two people on one public Bot are given two computers", async () => {
    const { provider, asked } = recording();
    const ada = await provider.locate(personSeat("ada", "pub-bot"));
    const bo = await provider.locate(personSeat("bo", "pub-bot"));
    expect(ada).not.toBe(bo);
    expect(asked.map((call) => call.path)).toEqual([
      "/computers/person/ada/ensure",
      "/computers/person/bo/ensure",
    ]);
  });

  test("one person's two Bots run on that person's one computer", async () => {
    const { provider, asked } = recording();
    const sales = await provider.locate(personSeat("ada", "sales"));
    const notes = await provider.locate(personSeat("ada", "notes"));
    expect(sales).toBe(notes);
    expect(new Set(asked.map((call) => call.path))).toEqual(
      new Set(["/computers/person/ada/ensure"]),
    );
  });

  test("an isolated Bot is given a computer of its own", async () => {
    const { provider, asked } = recording();
    const own = await provider.locate(botSeat("sales"));
    const adas = await provider.locate(personSeat("ada", "sales"));
    expect(own).not.toBe(adas);
    expect(asked[0]?.path).toBe("/computers/bot/sales/ensure");
  });

  test("a private Bot's old profile is asked for on its owner's computer, until it has been answered", async () => {
    const { provider, asked } = recording();
    const owners = { ...personSeat("ada", "notes"), inheritsProfile: true };
    await provider.locate(owners);
    await provider.locate(owners);
    expect(asked.map((call) => call.body)).toEqual([
      { carryOver: ["notes"] },
      undefined,
    ]);
  });

  test("a public Bot's seat never asks for one", async () => {
    const { provider, asked } = recording();
    await provider.locate(personSeat("bo", "pub-bot"));
    expect(asked.map((call) => call.body === undefined)).toEqual([true]);
  });

  test("a person's computer is listed as theirs", async () => {
    const provider = createDockerSupervisorProvider({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () =>
        Response.json({
          computers: [
            {
              kind: "person",
              id: "ada",
              status: "running",
              url: "http://a:4100",
            },
            {
              kind: "bot",
              id: "sales",
              status: "exited",
              url: "http://s:4100",
            },
          ],
        })) as unknown as typeof fetch,
    });
    expect((await provider.list()).map((computer) => computer.key)).toEqual([
      { kind: "person", personId: "ada" },
      { kind: "bot", botId: "sales" },
    ]);
    expect(await provider.status(personSeat("ada", "notes"))).toEqual({
      botId: "notes",
      state: "ready",
    });
  });
});
