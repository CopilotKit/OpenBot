import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

/**
 * The middleware from mountCopilotRuntime, over a stub runtime handler.
 *
 * Reproduced here rather than imported because building the real handler needs an Intelligence key
 * and a live platform; what is under test is the decision, not the runtime.
 */
function mount(inner: Hono, basePath = "/api/copilotkit") {
  const wrapped = new Hono();

  wrapped.use(
    `${basePath}/threads/:threadId/messages`,
    async (context, next) => {
      await next();
      if (context.req.method !== "GET" || context.res.status !== 500) return;

      const agentId = context.req.query("agentId");
      if (!agentId) return;
      const threadId = context.req.param("threadId");

      const listed = await inner.fetch(
        new Request(
          `${new URL(context.req.url).origin}${basePath}/threads?agentId=${encodeURIComponent(agentId)}`,
          { headers: context.req.raw.headers },
        ),
      );
      if (!listed.ok) return;

      const { threads } = (await listed.json()) as {
        threads?: { id: string }[];
      };
      if (!Array.isArray(threads)) return;
      if (threads.some((thread) => thread.id === threadId)) return;

      context.res = Response.json({ messages: [] });
    },
  );

  wrapped.route("/", inner);
  return wrapped;
}

const EXISTING = "d3ff669d-953c-4fab-888e-7eee3e989bf9";
const MINTED = "55569917-dab5-8851-920d-339a71b6ca78";

/** A runtime that lists one thread and fails every message read, as the platform does on 404. */
function runtime(options: { listOk?: boolean } = {}) {
  const inner = new Hono();
  inner.get("/api/copilotkit/threads", (context) =>
    options.listOk === false
      ? context.json({ error: "upstream down" }, 503)
      : context.json({ threads: [{ id: EXISTING }] }),
  );
  inner.get("/api/copilotkit/threads/:threadId/messages", (context) =>
    context.json({ error: "Failed to fetch thread messages" }, 500),
  );
  return inner;
}

const read = (
  app: Hono,
  threadId: string,
  query = "?agentId=general-assistant",
) => app.request(`/api/copilotkit/threads/${threadId}/messages${query}`);

describe("thread history fallback", () => {
  test("a minted thread the platform does not list reads as empty", async () => {
    const response = await read(mount(runtime()), MINTED);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [] });
  });

  test("a 500 on a thread that exists stays a 500", async () => {
    // The one that matters: an outage must not be reported as a conversation with no history,
    // which would invite the browser to start the thread over.
    const response = await read(mount(runtime()), EXISTING);
    expect(response.status).toBe(500);
  });

  test("a 500 stays a 500 when the listing itself fails", async () => {
    const response = await read(mount(runtime({ listOk: false })), MINTED);
    expect(response.status).toBe(500);
  });

  test("a 500 stays a 500 with no agentId to list against", async () => {
    const response = await read(mount(runtime()), MINTED, "");
    expect(response.status).toBe(500);
  });
});
