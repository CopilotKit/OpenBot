import { describe, expect, test } from "bun:test";
import {
  ComputerUnavailableError,
  createComputerClient,
  ElementNotFoundError,
  NavigationRefusedError,
} from "../src/computer/client";

function clientWith(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  allowPrivateHosts = false,
) {
  return createComputerClient({
    baseUrl: "http://agent-computer:4100",
    allowPrivateHosts,
    fetchImpl: ((url: string, init?: RequestInit) =>
      Promise.resolve(handler(url, init))) as unknown as typeof fetch,
  });
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("computer client", () => {
  test("navigates and returns where it landed", async () => {
    const seen: string[] = [];
    const client = clientWith((url, init) => {
      seen.push(url);
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://example.com/",
      });
      return ok({
        url: "https://example.com/",
        title: "Example",
        elapsedMs: 12,
      });
    });

    await expect(client.navigate("https://example.com/")).resolves.toEqual({
      url: "https://example.com/",
      title: "Example",
      elapsedMs: 12,
    });
    expect(seen).toEqual(["http://agent-computer:4100/navigate"]);
  });

  // The refusal happens before anything leaves. A guard that only inspects the response has
  // already let the request reach the internal service it was meant to protect.
  test("refuses an internal address without calling the computer", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({});
    });

    await expect(client.navigate("http://169.254.169.254/")).rejects.toThrow(
      NavigationRefusedError,
    );
    expect(called).toBe(false);
  });

  // The opt-in every laptop sets must not be a way to reach the cloud credential endpoint. The
  // earlier test above passes with the opt-in OFF, which is what let this through unnoticed.
  test("refuses cloud metadata even when private hosts are allowed", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({});
    }, true);

    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await expect(client.navigate(target)).rejects.toThrow(
        NavigationRefusedError,
      );
    }
    expect(called).toBe(false);
  });

  test("allows an internal address when the deployment opted in", async () => {
    const client = clientWith(
      () => ok({ url: "http://localhost:3000/", title: "Local", elapsedMs: 3 }),
      true,
    );

    await expect(
      client.navigate("http://localhost:3000/"),
    ).resolves.toMatchObject({ title: "Local" });
  });

  // Two different failures that read identically to a person unless we separate them: the computer
  // being absent is an operator problem, a page failing to load is not.
  test("reports an absent computer distinctly from a failed page", async () => {
    const missing = clientWith(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(missing.navigate("https://example.com")).rejects.toThrow(
      "The assistant's computer is not running.",
    );

    const badPage = clientWith(
      () =>
        new Response(JSON.stringify({ error: "net::ERR_NAME_NOT_RESOLVED" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(badPage.navigate("https://nope.example")).rejects.toThrow(
      "net::ERR_NAME_NOT_RESOLVED",
    );
  });

  test("status reports unreachable rather than throwing", async () => {
    const client = clientWith(() => {
      throw new Error("down");
    });

    await expect(client.status("bot-1")).resolves.toEqual({
      botId: "bot-1",
      state: "unreachable",
      reason: "The assistant's computer is not running.",
    });
  });

  test("screenshot returns the png a transcript can render", async () => {
    const client = clientWith(() =>
      ok({
        base64: "aGVsbG8=",
        width: 1280,
        height: 800,
        capturedAt: "2026-08-14T00:00:00.000Z",
      }),
    );

    await expect(client.screenshot()).resolves.toMatchObject({
      base64: "aGVsbG8=",
      width: 1280,
    });
  });

  test("surfaces a timeout as the computer not responding", async () => {
    const client = clientWith(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });

    await expect(client.status("bot-1")).resolves.toMatchObject({
      state: "unreachable",
      reason: "The assistant's computer did not respond in time.",
    });
  });

  test("refuses an unbound call when no baseUrl is configured", async () => {
    const client = createComputerClient({
      fetchImpl: ((url: string, init?: RequestInit) =>
        Promise.resolve(ok({}))) as unknown as typeof fetch,
    });

    await expect(client.navigate("https://example.com/")).rejects.toThrow(
      ComputerUnavailableError,
    );
    await expect(client.navigate("https://example.com/")).rejects.toThrow(
      "This deployment locates computers per Bot, and this call named no Bot.",
    );
  });

  test("routes to the resolved address when bound to a Bot without a shared baseUrl", async () => {
    const seen: string[] = [];
    const client = createComputerClient({
      resolveBaseUrl: async (botId) => `http://${botId}.daytona.internal:4100`,
      fetchImpl: ((url: string, init?: RequestInit) => {
        seen.push(url);
        return Promise.resolve(
          ok({
            url: "https://example.com/",
            title: "Example",
            elapsedMs: 10,
          }),
        );
      }) as unknown as typeof fetch,
    });

    const botClient = client.forBot("bot-123");
    await expect(
      botClient.navigate("https://example.com/"),
    ).resolves.toMatchObject({ title: "Example" });
    expect(seen).toEqual(["http://bot-123.daytona.internal:4100/navigate"]);
  });
});

/**
 * A ref that is not on the page.
 *
 * Reported as a stale snapshot, not as computer unavailability. A model can recover by taking a
 * fresh snapshot.
 */
describe("acting on an element that is not there", () => {
  const playwrightTimeout = {
    error:
      "click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e5')\n",
  };

  const timingOut = () =>
    clientWith(
      () =>
        new Response(JSON.stringify(playwrightTimeout), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

  test("is its own condition, not an unavailable computer", async () => {
    expect(
      timingOut().click({ ref: "e5", snapshotId: 1 }),
    ).rejects.toBeInstanceOf(ElementNotFoundError);
  });

  test("says what to do next, and drops the call log", async () => {
    try {
      await timingOut().click({ ref: "e5", snapshotId: 1 });
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      // The instruction, naming the ref that failed.
      expect(message).toContain("e5");
      expect(message).toContain("fresh snapshot");
      // Not several lines of Playwright internals, which are noise to a model and to a person.
      expect(message).not.toContain("Call log");
      expect(message).not.toContain("Timeout");
    }
  });
});

/**
 * Stop has to travel.
 *
 * Pressing Stop aborts the surface's request. That abort is only useful if it reaches the browser: a
 * click already running in Chromium otherwise lands anyway, which is harmless most of the time and
 * not harmless on a Confirm button, precisely the moment somebody presses Stop.
 */
describe("the caller's Stop", () => {
  test("is passed to the request, so it can reach the browser", async () => {
    let seen: AbortSignal | undefined;
    const client = clientWith((_url, init) => {
      seen = init?.signal ?? undefined;
      return ok({ action: "click" });
    });

    const stop = new AbortController();
    await client.click({ ref: "e1", snapshotId: 1 }, stop.signal);

    expect(seen).toBeDefined();
    // Not the caller's signal itself: it is combined with the timeout, because a computer that stops
    // answering must still end the request even when nobody pressed anything.
    expect(seen?.aborted).toBe(false);
    stop.abort();
    expect(seen?.aborted).toBe(true);
  });

  test("a request that was already stopped never reaches the computer", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({ action: "click" });
    });

    const stop = new AbortController();
    stop.abort();

    expect(
      client.click({ ref: "e1", snapshotId: 1 }, stop.signal),
    ).rejects.toBeDefined();
    expect(called).toBe(false);
  });

  test("without one, the timeout still applies", async () => {
    let seen: AbortSignal | undefined;
    const client = clientWith((_url, init) => {
      seen = init?.signal ?? undefined;
      return ok({ action: "click" });
    });

    await client.click({ ref: "e1", snapshotId: 1 });

    // A caller that passes nothing must not end up with an unbounded request.
    expect(seen).toBeDefined();
  });
});
