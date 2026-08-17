import { describe, expect, test } from "bun:test";
import {
  createSupervisorClient,
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

function clientWith(handler: (path: string) => Response) {
  return createSupervisorClient({
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
    const client = createSupervisorClient({
      baseUrl: "http://supervisor:4300",
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    expect(client.locate("sales")).rejects.toThrow(/could not be reached/);
  });

  test("the bot id is escaped into the path", async () => {
    let seen = "";
    const client = createSupervisorClient({
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
