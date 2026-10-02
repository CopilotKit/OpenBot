import {
  RoutineNotFoundError,
  RoutineRefusedError,
  type RoutineStore,
} from "../routines/store";
import { DemonstrationRefusedError } from "./types";

/** Only the routine store's own create: validation, the cap and the channel choice stay there. */
export type DemonstrationRoutineCreator = Pick<RoutineStore, "create">;

export type DemonstrationScheduleInput = {
  /** Five-field cron, validated by the routine store exactly as a Bot-created routine is. */
  cron: string;
  timezone?: string;
  channelId?: string;
  /** Values for the skill's parameters, since nobody is there to answer on a schedule. */
  inputs?: string;
};

/** Reads and bounds the request body; the routine store owns what a valid schedule is. */
export function parseDemonstrationSchedule(
  input: Record<string, unknown>,
): DemonstrationScheduleInput {
  const known = new Set(["cron", "timezone", "channelId", "inputs"]);
  if (Object.keys(input).some((key) => !known.has(key)))
    throw new DemonstrationRefusedError(
      "Supply only a schedule, a time zone, a conversation and inputs.",
    );
  const text = (value: unknown, max: number, label: string) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length > max)
      throw new DemonstrationRefusedError(`${label} is not valid.`);
    return value.trim() || undefined;
  };
  const cron = text(input.cron, 120, "The schedule");
  if (!cron)
    throw new DemonstrationRefusedError(
      "Choose when this skill runs, such as weekdays at 09:00.",
    );
  const timezone = text(input.timezone, 64, "The time zone");
  const channelId = text(input.channelId, 200, "The conversation");
  const inputs = text(input.inputs, 1000, "The inputs");
  return {
    cron,
    ...(timezone ? { timezone } : {}),
    ...(channelId ? { channelId } : {}),
    ...(inputs ? { inputs } : {}),
  };
}

/** The standing instruction a scheduled demonstration skill carries out. */
export function demonstrationRoutineInstruction(input: {
  title: string;
  slug: string;
  inputs?: string;
}): string {
  return [
    `Run the "${input.title}" browser skill (/${input.slug}) that was saved from a demonstration, following its reviewed steps.`,
    input.inputs
      ? `Use these inputs: ${input.inputs}`
      : "If the skill needs an input that was not supplied, stop and ask the person rather than guessing.",
    "Report what happened.",
  ].join(" ");
}

export async function scheduleDemonstrationSkill(
  routines: DemonstrationRoutineCreator,
  input: {
    ownerUserId: string;
    botId: string;
    title: string;
    slug: string;
    input: DemonstrationScheduleInput;
  },
) {
  try {
    const routine = await routines.create({
      ownerUserId: input.ownerUserId,
      agentId: input.botId,
      instruction: demonstrationRoutineInstruction({
        title: input.title,
        slug: input.slug,
        inputs: input.input.inputs,
      }),
      cron: input.input.cron,
      timezone: input.input.timezone,
      channelId: input.input.channelId,
    });
    return {
      id: routine.id,
      agentId: routine.agentId,
      channelId: routine.channelId,
      cron: routine.cron,
      timezone: routine.timezone,
      instruction: routine.instruction,
      nextRunAt: routine.nextRunAt,
    };
  } catch (error) {
    // The routine store's own sentence ("at most every 15 minutes", "twenty routines") is the one a
    // person can act on, so it is carried through rather than replaced.
    if (
      error instanceof RoutineRefusedError ||
      error instanceof RoutineNotFoundError
    )
      throw new DemonstrationRefusedError(error.message);
    throw error;
  }
}
