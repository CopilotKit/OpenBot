import {
  cronFrom,
  type RoutineEventSource,
  type RoutineFormValues,
} from "./form";
import type { RoutineInput } from "./mutations";

// The server's limit counts UTF-16 units, so cut by units without splitting a pair.
function cutToUnits(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

export type RoutinePlan =
  | { kind: "routine"; routine: RoutineInput }
  | {
      kind: "goal";
      goal: {
        agentId: string;
        channelId: string;
        title: string;
        instruction: string;
        successCriteria: string;
        subscriptions: { source: RoutineEventSource; eventType: string }[];
        recurring: boolean;
        endsWhenMet: boolean;
      };
      /** The routine that runs it, less the goal id it does not have yet. */
      schedule: { cron: string; timezone: string } | null;
      runNow: boolean;
    }
  | {
      kind: "check-in";
      /** No conversation: a check-in belongs to its Bot, and what it finds shows under Needs you. */
      checkIn: {
        agentId: string;
        focus: string;
        subject: string;
        intervalMinutes: number;
      };
    };

/** The instruction of the routine that runs a goal. Text for the model. */
export function runGoalInstruction(title: string, goalId: string): string {
  return `Run the goal "${title}" (${goalId}) with run_goal.`;
}

/**
 * What an Only tell you is called: its Name, else its instruction on one line, cut as a goal's title
 * is to the 120 the check-in store takes.
 *
 * FOUND IN REVIEW: a check-in with no Name went in with an empty subject, and the server counts a
 * check-in with no link and the same subject as the same one. A Bot's default check-in has an empty
 * subject, so every unnamed Only tell you landed on it and was refused as already there.
 */
export function checkInSubject(
  values: Pick<RoutineFormValues, "title" | "instruction">,
): string {
  return (
    values.title.trim() ||
    cutToUnits(values.instruction.trim().replace(/\s+/g, " "), 120).trim()
  );
}

/**
 * What the form's answers make. TanStack Form hands `onSubmit` the raw values, not zod's trimmed
 * output, so the text answers are trimmed here.
 */
export function planRoutine(
  values: RoutineFormValues,
  timezone: string,
): RoutinePlan {
  const { agentId, channelId } = values;
  const instruction = values.instruction.trim();
  const title = values.title.trim();
  const doneWhen = values.doneWhen.trim();

  if (values.does === "tell") {
    return {
      kind: "check-in",
      checkIn: {
        agentId,
        focus: instruction,
        subject: checkInSubject(values),
        intervalMinutes: Number(values.interval),
      },
    };
  }

  if (values.starts === "schedule" && !doneWhen) {
    return {
      kind: "routine",
      routine: {
        agentId,
        channelId,
        instruction,
        ...(title ? { title } : {}),
        cron: cronFrom(values),
        timezone,
      },
    };
  }

  // One line, as a routine's title is: the title goes inside the quotes of `runGoalInstruction`.
  // Cut after collapsing, then trim in case the cut lands on a space.
  const goalTitle =
    title || cutToUnits(instruction.replace(/\s+/g, " "), 160).trim();
  const goal = {
    agentId,
    channelId,
    title: goalTitle,
    instruction,
    successCriteria: doneWhen,
  };

  if (values.starts === "schedule") {
    return {
      kind: "goal",
      goal: { ...goal, subscriptions: [], recurring: false, endsWhenMet: true },
      schedule: { cron: cronFrom(values), timezone },
      runNow: false,
    };
  }

  if (values.starts === "event") {
    return {
      kind: "goal",
      goal: {
        ...goal,
        subscriptions: [
          { source: values.eventSource, eventType: values.eventType.trim() },
        ],
        recurring: !doneWhen,
        endsWhenMet: !!doneWhen,
      },
      schedule: null,
      runNow: false,
    };
  }

  // A Done when ends the goal when met, as it does under a schedule or an event, so a schedule or a
  // trigger added later does not turn it into a goal that repeats and no run can complete.
  return {
    kind: "goal",
    goal: {
      ...goal,
      subscriptions: [],
      recurring: false,
      endsWhenMet: !!doneWhen,
    },
    schedule: null,
    runNow: true,
  };
}
