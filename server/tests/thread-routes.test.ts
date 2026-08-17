import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createThreadIdentity } from "../src/channels/thread-identity";
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

function app() {
  return new Hono().route("/threads", createThreadRoutes(identity, asSignedIn));
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
