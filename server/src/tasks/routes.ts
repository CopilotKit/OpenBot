import { MAX_ATTACHMENTS_PER_MESSAGE } from "@openbot/shared/attachments";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AgentNotFoundError } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import type { TaskResponse, TasksResponse } from "../proactive/contracts";
import type { TaskReportReader } from "./report";
import type { TaskRunner } from "./runner";
import { TaskNotFoundError, TaskRefusedError, type TaskStore } from "./store";

/** The longest ask the + takes, as `start_task` takes. */
export const MAX_ASK = 4000;
/** The longest reply a task takes. */
const MAX_REPLY = 4000;
/** How long a title made from the ask gets before it is cut at a word. */
const TITLE_LENGTH = 80;

/**
 * A request the routes refuse as it stands: the person can fix it and send it again. A 400, where
 * `TaskRefusedError` is a 409: the task's state refusing it.
 */
export class TaskRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRequestError";
  }
}

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
    agentId: z.string().trim().min(1).max(200),
    instruction: z.string().trim().min(1).max(MAX_ASK),
    title: z.string().trim().min(1).max(160).optional(),
    /** The id the browser made for this Start, so sending it twice opens one task. */
    clientId: z.uuid().optional(),
  })
  .strict();

/**
 * The id the browser drew the person's message under, so the message the run records is the same
 * one and is not drawn twice.
 */
const messageId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

/** A reply carries words, files, or both, and the skills picked for it. */
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

/**
 * `/api/tasks`: the person's own tasks, as the task list and the "Needs you" list read them. Another
 * person's task is the same as no task. A task's page is its conversation; these routes say where it
 * stands, start one (the + on Tasks), take the person's replies in its order, and read its report.
 */
export function createTaskRoutes(
  store: TaskStore,
  runner: Pick<TaskRunner, "again"> &
    Partial<Pick<TaskRunner, "startAsked" | "reply">>,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: {
    /** Absent, a task's report is not served: there is no conversation history to read it from. */
    report?: TaskReportReader | undefined;
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof TaskNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof TaskRefusedError)
      return context.json({ error: error.message }, 409);
    if (error instanceof TaskRequestError)
      return context.json({ error: error.message }, 400);
    if (error instanceof AgentNotFoundError)
      return context.json(
        { error: "Couldn't find that Bot. Reload the page." },
        404,
      );
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
    context.json<TasksResponse>({
      tasks: await store.list(context.var.actor.id),
    }),
  );
  const startAsked = runner.startAsked;
  if (startAsked)
    /*
     * The + on Tasks, Start now: the ask opens a task in a conversation of its own with the Bot the
     * person chose, and starts there, the path `start_task` takes. Answers with the task as Tasks
     * reads it.
     *
     * A Start sent again with the same `clientId`, a double click or a retried request, answers the
     * task the first one opened, and starts nothing more.
     */
    routes.post("/", async (context) => {
      const owner = context.var.actor.id;
      const ask = await readAsk(context.req.raw);
      const opened = await startAsked(owner, ask.agentId, {
        title: ask.title,
        instruction: ask.instruction,
        ...(ask.clientId ? { clientId: ask.clientId } : {}),
      });
      return context.json<TaskResponse>(
        { task: await store.get(owner, opened.id) },
        201,
      );
    });
  routes.get("/:id", async (context) =>
    context.json<TaskResponse>({
      task: await store.get(context.var.actor.id, context.req.param("id")),
    }),
  );
  const report = options.report;
  if (report)
    /*
     * The task page's report: what was asked, what was decided in it, what the Bot said as each turn
     * ended, and the person's replies, worked out from its conversation on every read
     * (tasks/report.ts).
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
  const reply = runner.reply;
  if (reply)
    /*
     * A reply in the task's conversation, to steer it. Taken onto the queue and answered at once,
     * with the task as it now reads: its turn runs when the conversation is free, in the task's
     * order, and until then the reply is in `queuedReplies`.
     */
    routes.post("/:id/reply", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const parsed = replySchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        throw new TaskRequestError(
          `A reply of at most ${MAX_REPLY} characters or an attachment, and its message id, are required.`,
        );
      await store.get(owner, id);
      await reply(owner, id, parsed.data);
      return context.json<TaskResponse>(
        { task: await store.get(owner, id) },
        202,
      );
    });
  routes.post("/:id/resolve", async (context) =>
    context.json<TaskResponse>({
      task: await store.resolve(context.var.actor.id, context.req.param("id")),
    }),
  );
  routes.post("/:id/reopen", async (context) =>
    context.json<TaskResponse>({
      task: await store.reopen(context.var.actor.id, context.req.param("id")),
    }),
  );
  /*
   * Try again: the failed turn runs once more, in the task's own conversation. Answered with the task
   * as it stands now, which is Working.
   */
  routes.post("/:id/again", async (context) => {
    const owner = context.var.actor.id;
    const id = context.req.param("id");
    await runner.again(owner, id);
    return context.json<TaskResponse>({ task: await store.get(owner, id) });
  });
  return routes;
}

/** The +'s ask, with its title worked out when the person gave none. */
async function readAsk(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new TaskRequestError("Say what your Bot should do.");
  const parsed = askSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    throw new TaskRequestError(
      parsed.error.issues.some((issue) => issue.path[0] === "instruction")
        ? `Say what your Bot should do, in at most ${MAX_ASK} characters.`
        : parsed.error.issues.some((issue) => issue.path[0] === "clientId")
          ? "Couldn't start this task. Reload the page and try again."
          : "Choose one of your Bots.",
    );
  const { agentId, instruction, clientId } = parsed.data;
  return {
    agentId,
    instruction,
    ...(clientId ? { clientId } : {}),
    title: parsed.data.title ?? titleFrom(instruction),
  };
}
