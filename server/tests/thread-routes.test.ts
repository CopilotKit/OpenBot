import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createThreadIdentity } from "../src/channels/thread-identity";
import type { ThreadReader } from "../src/channels/thread-routes";
import { createThreadRoutes } from "../src/channels/thread-routes";

/**
 * Handing out a thread id for a conversation with no channel.
 *
 * The direct Bot chat needs one before it starts, and it has to come from here: a thread the chat
 * names itself is one nothing can later attribute to this deployment.
 */

const identity = createThreadIdentity("openbot-test");

const asSignedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "u1", email: "someone@openbot.test" });
  return next();
};

function app(reader?: ThreadReader) {
  return new Hono().route(
    "/threads",
    createThreadRoutes(identity, asSignedIn, reader),
  );
}

async function mint() {
  const response = await app().request("http://openbot.local/threads/mint", {
    method: "POST",
  });
  return (await response.json()) as { threadId: string };
}

describe("minting a thread", () => {
  test("returns one this deployment can recognise later", async () => {
    const { threadId } = await mint();
    expect(identity.owns(threadId)).toBe(true);
  });

  test("returns a different one every time", async () => {
    const first = await mint();
    const second = await mint();
    expect(first.threadId).not.toBe(second.threadId);
  });

  test("does not answer a caller with no session", async () => {
    const refusing: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
    ) => context.json({ error: "Unauthorized." }, 401);
    const response = await new Hono()
      .route("/threads", createThreadRoutes(identity, refusing))
      .request("http://openbot.local/threads/mint", { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("checking whether a remembered thread is still known upstream", () => {
  test("answers known when the reader can produce the thread", async () => {
    const threadId = identity.mint();
    const response = await app(async () => "known").request(
      `http://openbot.local/threads/${threadId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ known: true });
  });

  test("answers unknown when the reader reports Intelligence has never heard of it", async () => {
    const threadId = identity.mint();
    const response = await app(async () => "unknown").request(
      `http://openbot.local/threads/${threadId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ known: false });
  });

  test("answers 502, not the reader's own error, when the check itself fails", async () => {
    // A message this specific would leak whatever the upstream call failed with; the caller only
    // ever needs to know the check could not be completed.
    const reader = async () => {
      throw new Error(
        "intelligence-platform: connection reset by peer at 10.0.4.7:443",
      );
    };
    const response = await app(reader).request(
      `http://openbot.local/threads/${identity.mint()}`,
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toContain("connection reset by peer");
    expect(body.error).not.toContain("10.0.4.7");
  });

  test("is not registered at all when the deployment has no reader, and mint keeps working", async () => {
    // No reader means no way to configure one, not an outage: `POST /mint` must be unaffected by a
    // route that was never wired up.
    const bare = app();
    const status = await bare.request(
      `http://openbot.local/threads/${identity.mint()}`,
    );
    expect(status.status).toBe(404);

    const minted = await bare.request("http://openbot.local/threads/mint", {
      method: "POST",
    });
    expect(minted.status).toBe(200);
  });

  test("asks about the user the session established, not one smuggled in the request", async () => {
    const calls: Array<{ threadId: string; userId: string }> = [];
    const threadId = identity.mint();
    const reader = async (id: string, userId: string) => {
      calls.push({ threadId: id, userId });
      return "known" as const;
    };
    await app(reader).request(
      `http://openbot.local/threads/${threadId}?userId=someone-else`,
    );
    expect(calls).toEqual([{ threadId, userId: "u1" }]);
  });
});
