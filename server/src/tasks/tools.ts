import { START_TASK_TOOL } from "@openbot/shared/task-brief";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AuditInitiator } from "../audit";
import type { Database } from "../db/client";
import { agents } from "../db/schema";
import type { AskedTask, OpenedTask } from "../proactive/engine";

export { START_TASK_TOOL };
/** The whole ask, in the person's words or a faithful restatement. Room for a long paragraph. */
export const MAX_INSTRUCTION = 4000;
/**
 * How many tasks one turn may start. Enough for a person who asks for several things at once; a
 * page or message the Bot read can't use one turn to start dozens of headless turns.
 */
export const MAX_TASKS_PER_TURN = 5;

/** Opens a task in a conversation of its own and starts it: the proactive engine's `startAsked`. */
export type TaskStarter = (input: {
  ownerUserId: string;
  agentId: string;
  task: AskedTask;
}) => Promise<OpenedTask>;

/**
 * Whether OpenBot runs this Bot itself, on its own runtime, rather than a remote agent framework
 * behind an endpoint. Only those hand work to a task from a conversation: a remote Bot composes its
 * own turn at somebody else's server, so it is not told to, and its tasks start from the + on Tasks
 * and from its suggestions instead.
 */
export function builtInBots(database: Pick<Database, "select">) {
  return async (botId: string): Promise<boolean> => {
    const [row] = await database
      .select({ type: agents.type })
      .from(agents)
      .where(eq(agents.id, botId))
      .limit(1);
    return row?.type === "built_in";
  };
}

const startParameters = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe(
        "The task's name on its card: a short imperative, e.g. 'Draft a reply to Rosa about Oat Satin'.",
      ),
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(MAX_INSTRUCTION)
      .describe(
        "The whole ask, in the person's words or a faithful restatement, with every detail they gave. The task starts from this alone.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .optional()
      /*
       * Shown on the task's report as its why, so it is the person's, never the Bot's: a Bot told
       * only "why it matters" filled it with its own reason for making a task ("a multi-step planning
       * request that benefits from a dedicated task").
       */
      .describe(
        "Why it matters to the person or by when, only as they said it and in their words; leave it out when they said neither. Never your own reason for making this a task, such as that it has several steps.",
      ),
    source: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "The app it came from, as the person would say it: 'Gmail', 'Google Calendar'. Leave out when it came from the conversation itself; never what kind of request it is or why it is a task.",
      ),
    link: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "Links must be http or https URLs.",
      )
      .optional()
      .describe(
        "The link to the email or event it came from, exactly as you read it. Leave out when you have none; never a page to use for the work, and never one you made up.",
      ),
  })
  .strict();

/**
 * `start_task`: anything bigger than a quick answer, handed off from a conversation to a task of its
 * own.
 *
 * The conversation stays one thread. The work happens in the task's own conversation with the same
 * Bot, which the person opens from the card this leaves and can reply in to steer; the conversation
 * it was asked in only says "On it". Opening the task and starting its turn is the proactive engine's
 * (`startAsked`), the path the + on Tasks takes, so both run, wait and finish the same way as a
 * started suggestion.
 *
 * Nothing leaves the deployment here: the turn it starts is the person's own, made on their behalf in
 * their words, and anything it then tries to send meets the approval gate as any turn of theirs does.
 *
 * So it is offered only in a conversation a person started. A routine, a responsibility, a wake-up or
 * a hand-off acting on what it read would otherwise start a turn that runs as the person, past every
 * rule written for unattended runs and credited to them on the trail. A task's own turn is never
 * offered it either: there the work is done, not handed on again.
 */
export async function taskTools(options: {
  actorId: string;
  botId: string;
  initiator: AuditInitiator;
  start: TaskStarter;
  /** Whether OpenBot runs this Bot itself. See `builtInBots`. */
  builtIn: (botId: string) => Promise<boolean>;
  /** This turn is a task's own. See `AgentResolutionContext.task`. */
  inTask?: boolean;
}): Promise<GrantedTool[]> {
  if (options.initiator.kind !== "person" || options.inTask) return [];
  if (!(await options.builtIn(options.botId))) return [];
  // Tools are built for each turn, so this counts one turn's starts.
  let started = 0;
  return [
    {
      name: START_TASK_TOOL,
      ref: `tasks/${START_TASK_TOOL}`,
      description: [
        "Hand work to a task of its own, which runs in the background in a separate conversation with you, and leave a card for it here.",
        "Use it for anything bigger than a quick answer: drafting, researching, preparing something, or any job of several steps or more than one reply.",
        'Call it once per piece of work; two separate asks are two tasks. Then reply only "On it.", or "On it" and one short clause, and do not do the work here.',
        "Never call it inside a task's own conversation; there, do the work.",
      ].join(" "),
      parameters: startParameters,
      initiator: options.initiator,
      async execute(args) {
        const parsed = startParameters.safeParse(args ?? {});
        if (!parsed.success)
          return `Refused. ${START_TASK_TOOL} takes a title (at most 160 characters) and the instruction (at most ${MAX_INSTRUCTION}); why, source and link are optional, and a link must be an http or https URL. ${parsed.error.issues[0]?.message ?? ""}`.trim();
        // Counted before the start is awaited, so calls made in parallel are held to it too.
        if (started >= MAX_TASKS_PER_TURN)
          return `Refused. One reply starts at most ${MAX_TASKS_PER_TURN} tasks. Tell the person which ones are under way, and ask them to send the rest in another message.`;
        started += 1;
        const task = await options.start({
          ownerUserId: options.actorId,
          agentId: options.botId,
          task: parsed.data,
        });
        return JSON.stringify({
          taskId: task.id,
          channelId: task.channelId,
          title: task.title,
          note: 'The task is under way in its own conversation, and its card is under your reply. Reply only "On it.", or "On it" and one short clause. Do not describe the task or what happens next, and do not do the work here.',
        });
      },
    },
  ];
}
