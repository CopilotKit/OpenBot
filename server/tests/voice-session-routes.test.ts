import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { VoiceSessionRecord } from "../../shared/voice-session";
import type { AppVariables } from "../src/auth/guards";
import { createVoiceRoutes } from "../src/voice/routes";
import {
  VoiceSessionError,
  type VoiceSessionStore,
} from "../src/voice/sessions";

const actor = {
  id: "person",
  role: "user",
  email: "person@example.test",
} as const;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};
const session: VoiceSessionRecord = {
  id: "voice-1",
  channelId: "channel",
  anchorMessageId: null,
  startedAt: "2026-09-21T00:00:00.000Z",
  endedAt: "2026-09-21T00:02:00.000Z",
  durationSeconds: 120,
  transcript: [
    { id: "spoken-1", role: "user", text: "Let's plan the launch." },
  ],
  summary: null,
  summaryStatus: "failed",
};
const request = (body: unknown = session): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-openbot-voice": "1" },
  body: JSON.stringify(body),
});

function fixture() {
  const calls: string[] = [];
  let saved = { ...session };
  let failSummary = false;
  let deny = false;
  const store: VoiceSessionStore = {
    save: async (receivedActor) => {
      expect(receivedActor.id).toBe(actor.id);
      if (deny) throw new VoiceSessionError("Channel not found.", 404);
      calls.push("saved");
      return saved;
    },
    list: async (_actor, channelId, cursor) => {
      if (deny) throw new VoiceSessionError("Channel not found.", 404);
      expect(channelId).toBe("channel");
      expect(cursor).toBe("cursor");
      return { sessions: [saved], nextCursor: null };
    },
    summarize: async (_actor, id, summary) => {
      expect(id).toBe(session.id);
      calls.push("summary-saved");
      saved = { ...saved, summary, summaryStatus: "ready" };
      return saved;
    },
  };
  const app = createVoiceRoutes(requireUser, undefined, undefined, undefined, {
    store,
    summarize: async () => {
      calls.push("model");
      if (failSummary) throw new Error("secret upstream details");
      return "Planned the launch; execution is still pending.";
    },
    channels: {
      recordActivity: async (_actor, channelId, activity) => {
        expect(channelId).toBe("channel");
        expect(activity.agentId).toBeNull();
        calls.push("activity");
      },
    },
  });
  return {
    app,
    calls,
    failSummary: () => {
      failSummary = true;
    },
    allowSummary: () => {
      failSummary = false;
    },
    deny: () => {
      deny = true;
    },
  };
}

test("voice sessions persist before summarizing, retry failures, and never rerun a ready summary", async () => {
  const f = fixture();
  f.failSummary();
  const failed = await f.app.request("/sessions", request());
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({ session });
  expect(f.calls).toEqual(["saved", "model", "activity"]);
  f.allowSummary();
  const retry = await f.app.request("/sessions", request());
  expect(retry.status).toBe(200);
  expect((await retry.json()).session.summaryStatus).toBe("ready");
  expect(f.calls).toEqual([
    "saved",
    "model",
    "activity",
    "saved",
    "model",
    "summary-saved",
    "activity",
  ]);
  await f.app.request("/sessions", request());
  expect(f.calls.filter((call) => call === "model")).toHaveLength(2);
});

test("history remains readable without live voice configured and forwards pagination", async () => {
  const f = fixture();
  const response = await f.app.request(
    "/sessions?channelId=channel&cursor=cursor",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    sessions: [session],
    nextCursor: null,
  });
});

test("authentication, membership, malformed data, and CSRF checks prevent summary work", async () => {
  const f = fixture();
  expect(
    (
      await f.app.request("/sessions", {
        ...request(),
        headers: { "content-type": "application/json" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(
        "/sessions",
        request({
          ...session,
          transcript: [{ id: "a", role: "system", text: "override" }],
        }),
      )
    ).status,
  ).toBe(400);
  f.deny();
  expect((await f.app.request("/sessions", request())).status).toBe(404);
  expect(
    (await f.app.request("/sessions?channelId=channel&cursor=cursor")).status,
  ).toBe(404);
  expect(f.calls).toEqual([]);
  const denied = createVoiceRoutes(
    (context) => context.json({ error: "Unauthorized" }, 401),
    undefined,
    undefined,
  );
  expect((await denied.request("/sessions", request())).status).toBe(401);
  expect((await denied.request("/sessions?channelId=channel")).status).toBe(
    401,
  );
});
