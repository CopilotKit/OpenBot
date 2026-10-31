import { MAX_ATTACHMENTS_PER_MESSAGE } from "@openbot/shared/attachments";
import type { DurableTaskReply } from "@openbot/shared/task-reply";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import { ProactiveRefusedError } from "../proactive/types";
import type { TaskReportReader } from "./report";
import type { TaskStore } from "./store";
import { TaskNotFoundError } from "./types";

/** Replies to a task, and Try again: the proactive engine's `reply` and `again`. */
export type TaskRetry = {
  reply(
    ownerUserId: string,
    taskId: string,
    input: DurableTaskReply,
  ): Promise<unknown>;
  again(
    ownerUserId: string,
    taskId: string,
    input?: { reply?: string; messageId?: string },
  ): Promise<unknown>;
};

/** The longest reply a task takes. */
const MAX_REPLY = 4000;
/**
 * The id the browser drew the person's message under, so the message the run records is the same
 * one and is not drawn twice.
 */
const messageId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

const againSchema = z
  .object({
    reply: z.string().trim().max(MAX_REPLY).optional(),
    messageId: messageId.optional(),
  })
  .strict();

/** A reply carries words, files, or both, and the skills picked for it. Try again takes words only. */
const replySchema = z
  .object({
    reply: z.string().trim().max(MAX_REPLY).default(""),
    messageId,
    attachmentIds: z
      .array(z.uuid())
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .optional(),
    skillIds: z.array(z.string().min(1).max(200)).max(32).optional(),
  })
  .strict()
  .refine(
    (input) => input.reply.length > 0 || (input.attachmentIds?.length ?? 0) > 0,
  );

/** Starts a task the person asked for from the + on Tasks: the proactive engine's `startAsked`. */
export type TaskIntake = {
  start(
    ownerUserId: string,
    botId: string,
    task: { title: string; instruction: string },
  ): Promise<{ id: string }>;
};

/** The longest ask the + takes, as `start_task` takes. */
export const MAX_ASK = 4000;
/** How long a title made from the ask gets before it is cut at a word. */
const TITLE_LENGTH = 80;

/**
 * A task's title from the person's ask when they gave none: the first sentence of its first line,
 * with its full stop dropped, cut at a word with an ellipsis past `TITLE_LENGTH`.
 */
export function titleFrom(ask: string): string {
  const line =
    ask
      .split("\n")
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  // A sentence ends at a stop followed by a capital: "Sam. He", but not "no. 5521" or "it... then".
  const sentence = line.split(/(?<=[^.][.!?])\s+(?=\p{Lu})/u)[0] ?? line;
  const plain = sentence.replace(/(?<!\.)\.$/, "");
  if (plain.length <= TITLE_LENGTH) return plain;
  const cut = plain.slice(0, TITLE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const askSchema = z
  .object({
    botId: z.string().trim().min(1).max(200),
    instruction: z.string().trim().min(1).max(MAX_ASK),
    title: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

/** A request the routes refuse as it stands: the person can fix it and send it again. */
export class TaskRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRefusedError";
  }
}

/** `/api/tasks`: the person's own tasks, as Tasks and the task page read and steer them. */
export function createTaskRoutes(
  store: TaskStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: {
    /** Absent, replying and Try again are not served: there is nothing to run them. */
    retry?: TaskRetry | undefined;
    /** Absent, the + is not served: there is nowhere to start a task. */
    intake?: TaskIntake | undefined;
    /** Absent, a task's report is not served: there is no conversation history to read it from. */
    report?: TaskReportReader | undefined;
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof TaskNotFoundError)
      return context.json({ error: error.message }, 404);
    // Asked for something the task's state refuses: Try again on one that did not fail, say.
    if (error instanceof ProactiveRefusedError)
      return context.json({ error: error.message }, 409);
    if (error instanceof AgentNotFoundError)
      return context.json(
        { error: "Couldn't find that Bot. Reload the page." },
        404,
      );
    if (error instanceof TaskRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "tasks-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Couldn't load your tasks. Try again." }, 503);
  });
  routes.get("/", async (context) =>
    context.json({ tasks: await store.list(context.var.actor.id) }),
  );
  const intake = options.intake;
  if (intake)
    /*
     * The + on Tasks, Start now: the ask opens a task in a conversation of its own with the Bot the
     * person chose, and starts there, the path `start_task` takes. Any Bot of theirs, wherever it
     * runs. Answers with the task as Tasks reads it.
     */
    routes.post("/", async (context) => {
      const owner = context.var.actor.id;
      const ask = await readAsk(context.req.raw);
      const opened = await intake.start(owner, ask.botId, {
        title: ask.title,
        instruction: ask.instruction,
      });
      return context.json({ task: await store.get(owner, opened.id) }, 201);
    });
  routes.get("/:id", async (context) =>
    context.json({
      task: await store.get(context.var.actor.id, context.req.param("id")),
    }),
  );
  const report = options.report;
  if (report)
    /*
     * The task page's report: what was decided in it, what the Bot said as each turn ended, and the
     * person's replies, worked out from its conversation on every read (tasks/report.ts).
     */
    routes.get("/:id/report", async (context) => {
      const owner = context.var.actor.id;
      const task = await store.get(owner, context.req.param("id"));
      try {
        return context.json({ report: await report(owner, task) });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "task-report-error",
            error: error instanceof Error ? error.name : "UnknownError",
            timestamp: new Date().toISOString(),
          }),
        );
        return context.json(
          { error: "Couldn't load this task's report. Try again." },
          503,
        );
      }
    });
  const retry = options.retry;
  if (retry) {
    /*
     * A reply in the task's conversation, to steer it. Taken onto the queue and answered at once,
     * with the task as it now reads: its turn runs when the conversation is free, and until then
     * the reply is in `queuedReplies`.
     */
    routes.post("/:id/reply", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const parsed = replySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        throw new TaskRefusedError(
          `A reply of at most ${MAX_REPLY} characters or an attachment, and its message id, are required.`,
        );
      await store.get(owner, id);
      await retry.reply(owner, id, parsed.data);
      return context.json({ task: await store.get(owner, id) }, 202);
    });
    /*
     * Try again: the failed turn runs once more, in the task's own conversation. A reply typed on a
     * failed task comes here too, and goes with the ask, so the run has the task and the person's
     * words both.
     */
    routes.post("/:id/again", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const body = context.req
        .header("content-type")
        ?.includes("application/json")
        ? await context.req.json().catch(() => null)
        : {};
      const parsed = againSchema.safeParse(body ?? {});
      if (!parsed.success)
        throw new TaskRefusedError(
          `Say it in at most ${MAX_REPLY} characters.`,
        );
      await retry.again(owner, id, {
        ...(parsed.data.reply ? { reply: parsed.data.reply } : {}),
        ...(parsed.data.messageId ? { messageId: parsed.data.messageId } : {}),
      });
      return context.json({ task: await store.get(owner, id) });
    });
  }
  routes.post("/:id/resolve", async (context) =>
    context.json({
      task: await store.resolve(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/reopen", async (context) =>
    context.json({
      task: await store.reopen(context.var.actor.id, context.req.param("id")),
    }),
  );
  return routes;
}

/** The +'s ask, with its title worked out when the person gave none. */
async function readAsk(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new TaskRefusedError("Say what your Bot should do.");
  const parsed = askSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    throw new TaskRefusedError(
      parsed.error.issues.some((issue) => issue.path[0] === "instruction")
        ? `Say what your Bot should do, in at most ${MAX_ASK} characters.`
        : "Choose one of your Bots.",
    );
  const { botId, instruction } = parsed.data;
  return {
    botId,
    instruction,
    title: parsed.data.title ?? titleFrom(instruction),
  };
}
